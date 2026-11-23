"""Private, authenticated single-recipient EWS sender, separate from read-only sync."""
import argparse
import base64
import email.policy
import email.utils
import hashlib
import hmac
import html
import http.client
import http.server
import importlib.util
import json
import os
import re
import socketserver
import ssl
import stat
import tempfile
import threading
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape
from email.message import EmailMessage
from pathlib import Path

RECIPIENT = 'recruiting-operator@example.invalid'
NS = {'m': 'http://schemas.microsoft.com/exchange/services/2006/messages',
      't': 'http://schemas.microsoft.com/exchange/services/2006/types'}
MAX_REQUEST = 65536

class DeliveryRejected(RuntimeError):
    pass


def private_bytes(filename, maximum=65536):
    info = os.stat(filename)
    if not stat.S_ISREG(info.st_mode) or (os.name != 'nt' and info.st_mode & 0o077) or info.st_size > maximum:
        raise RuntimeError('private_file_invalid')
    return Path(filename).read_bytes()


def settings(filename):
    value = json.loads(private_bytes(filename).decode('utf-8'))
    required = {'mailboxConfigFile', 'readOnlyClientFile', 'socketPath', 'tokenFile', 'receiptRoot'}
    if set(value) != required or any(not isinstance(v, str) or not os.path.isabs(v) for v in value.values()):
        raise RuntimeError('bridge_configuration_invalid')
    return value


def load_runtime(config):
    token = private_bytes(config['tokenFile'], 200).decode('ascii').strip()
    if not re.fullmatch('[a-f0-9]{64}', token):
        raise RuntimeError('bridge_token_invalid')
    account_bytes = private_bytes(config['mailboxConfigFile'])
    account = json.loads(account_bytes.decode('utf-8'))
    if not all(isinstance(account.get(k), str) and account[k] for k in
               ('host', 'domain', 'username', 'password', 'account', 'certificate', 'certificateSha256')):
        raise RuntimeError('mailbox_configuration_invalid')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}', account['host']):
        raise RuntimeError('mailbox_host_invalid')
    if not re.fullmatch(r'[A-Za-z0-9.!#$%&\'*+/=?^_`|~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', account['account']):
        raise RuntimeError('mailbox_account_invalid')
    spec = importlib.util.spec_from_file_location('recruit_readonly_ews', config['readOnlyClientFile'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Reuse the deployed client's verified leaf pin and dependency path. Never change its allowlist.
    readonly = module.Ews(account)
    material = account_bytes + readonly.fingerprint + Path(config['readOnlyClientFile']).read_bytes() + Path(__file__).read_bytes()
    revision = hmac.new(token.encode('ascii'), material, hashlib.sha256).hexdigest()
    return {'token': token, 'account': account['account'], 'revision': revision, 'sender': EwsSender(readonly)}


def validate_message(message, account):
    required = {'from', 'to', 'subject', 'text', 'messageId'}
    if not isinstance(message, dict) or not required.issubset(message) or set(message) - required - {'inReplyTo', 'references'}:
        raise RuntimeError('message_invalid')
    sender = message['from']
    if not isinstance(sender, dict) or set(sender) != {'name', 'address'} or sender['address'] != account:
        raise RuntimeError('recipient_or_sender_forbidden')
    if not isinstance(message['to'], str) or len(message['to']) > 254 or not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`|~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}", message['to']):
        raise RuntimeError('recipient_or_sender_forbidden')
    for value, maximum in [(sender['name'], 120), (message['subject'], 2000)]:
        if not isinstance(value, str) or not 0 < len(value) <= maximum or re.search(r'[\x00-\x1f\x7f]', value):
            raise RuntimeError('message_header_invalid')
    if message['subject'].startswith('[模板测试] ') and message['to'] != RECIPIENT:
        raise RuntimeError('test_recipient_required')
    if not isinstance(message['text'], str) or not 0 < len(message['text']) <= 16000 or '\x00' in message['text']:
        raise RuntimeError('message_body_invalid')
    if re.search(r'[{}｛｝]|yourcompany|candidate@example', message['subject'] + message['text'], re.I):
        raise RuntimeError('message_placeholder')
    values = [message['messageId']]
    if 'inReplyTo' in message:
        values.append(message['inReplyTo'])
    references = message.get('references', [])
    if not isinstance(references, list) or len(references) > 100:
        raise RuntimeError('message_header_invalid')
    values += references
    if any(not isinstance(v, str) or len(v) > 1000 or any(ord(c) < 33 or ord(c) > 126 for c in v)
           or not re.fullmatch(r'<[^<>\s@]+@[^<>\s@]+>', v) for v in values):
        raise RuntimeError('message_header_invalid')
    return message


def reply_body(text):
    # Match the restricted named-HTTPS-link renderer in src/mailbox/reply-body.ts.
    links = re.compile(r'\[([^\]\r\n]+)\]\((https://[^\s<>"\x27()]+)\)')
    matches = list(links.finditer(text))
    if not matches:
        return text, None
    parts, offset = [], 0
    for match in matches:
        parts.extend([html.escape(text[offset:match.start()]),
                      '<a href="' + html.escape(match[2]) + '">' + html.escape(match[1]) + '</a>'])
        offset = match.end()
    parts.append(html.escape(text[offset:]))
    plain = links.sub(lambda match: match[1] + ' (' + match[2] + ')', text)
    rich = '<div>' + re.sub(r'\r\n|\r|\n', '<br>\n', ''.join(parts)) + '</div>'
    return plain, rich


def mime_bytes(message, account):
    validate_message(message, account)
    mail = EmailMessage(policy=email.policy.default)
    mail['From'] = email.utils.formataddr((message['from']['name'], account))
    mail['To'] = message['to']
    mail['Subject'] = message['subject']
    mail['Date'] = email.utils.formatdate(localtime=False, usegmt=True)
    mail['Message-ID'] = message['messageId']
    mail['X-Recruit-Template-Test'] = 'true' if message['to'] == RECIPIENT else 'false'
    if message.get('inReplyTo'):
        mail['In-Reply-To'] = message['inReplyTo']
    if message.get('references'):
        mail['References'] = ' '.join(message['references'])
    plain, rich = reply_body(message['text'])
    mail.set_content(plain, charset='utf-8', cte='quoted-printable')
    if rich is not None:
        mail.add_alternative(rich, subtype='html', charset='utf-8', cte='quoted-printable')
    # Python 3.6 SMTP header folding duplicates CR for encoded Chinese From.
    # Generate LF-only MIME first, then convert to canonical wire CRLF once.
    return mail.as_bytes().replace(b"\n", b"\r\n")


def validate_create_response(data):
    root = ET.fromstring(data)
    responses = root.findall('.//m:CreateItemResponseMessage', NS)
    if len(responses) != 1:
        raise RuntimeError('ews_response_unconfirmed')
    codes = responses[0].findall('m:ResponseCode', NS)
    if len(codes) != 1:
        raise RuntimeError('ews_response_unconfirmed')
    code, kind = codes[0].text, responses[0].get('ResponseClass')
    if kind == 'Success' and code == 'NoError':
        return
    if kind == 'Error' and code in {'ErrorAccessDenied', 'ErrorInvalidRecipients', 'ErrorSendAsDenied', 'ErrorRecipientNotFound', 'ErrorInvalidPropertyRequest'}:
        raise DeliveryRejected('ews_response_rejected')
    raise RuntimeError('ews_response_unconfirmed')


class EwsSender:
    def __init__(self, readonly):
        self.readonly = readonly

    def check(self):
        return self.readonly.call('GetFolder', '<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds><t:DistinguishedFolderId Id="inbox"/></m:FolderIds></m:GetFolder>')

    def send(self, message):
        content = base64.b64encode(mime_bytes(message, self.readonly.config['account'])).decode('ascii')
        # No caller-supplied operation, XML, recipients, attachments, or remote URLs.
        body = ('<m:CreateItem MessageDisposition="SendAndSaveCopy"><m:SavedItemFolderId>'
                '<t:DistinguishedFolderId Id="sentitems"/></m:SavedItemFolderId><m:Items><t:Message>'
                '<t:MimeContent CharacterSet="UTF-8">' + content + '</t:MimeContent>'
                '<t:ToRecipients><t:Mailbox><t:EmailAddress>' + escape(message['to']) + '</t:EmailAddress>'
                '</t:Mailbox></t:ToRecipients></t:Message></m:Items></m:CreateItem>')
        self._create(body)

    def _create(self, body):
        # Authentication is the deployed EWS NTLMv2 flow, with the same channel binding and leaf pin.
        from ntlm_auth.ntlm import NtlmContext
        from ntlm_auth.gss_channel_bindings import GssChannelBindingsStruct
        config, fingerprint = self.readonly.config, self.readonly.fingerprint
        context = ssl.create_default_context(cafile=config['certificate'])
        context.verify_flags |= getattr(ssl, 'VERIFY_X509_PARTIAL_CHAIN', 0x80000)
        if not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED:
            raise RuntimeError('tls_verification_required')
        connection = http.client.HTTPSConnection(config['host'], 443, context=context, timeout=15)
        try:
            connection.connect()
            if hashlib.sha256(connection.sock.getpeercert(binary_form=True)).digest() != fingerprint:
                raise RuntimeError('server_certificate_mismatch')
            bindings = GssChannelBindingsStruct()
            bindings[bindings.APPLICATION_DATA] = b'tls-server-end-point:' + fingerprint
            ntlm = NtlmContext(config['username'], config['password'], domain=config['domain'],
                               cbt_data=bindings, ntlm_compatibility=3)
            payload = ('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="' + NS['m'] +
                       '" xmlns:t="' + NS['t'] + '"><s:Header><t:RequestServerVersion Version="Exchange2013_SP1"/>'
                       '</s:Header><s:Body>' + body + '</s:Body></s:Envelope>').encode('utf-8')
            headers = {'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': NS['m'] + '/CreateItem',
                       'Authorization': 'NTLM ' + base64.b64encode(ntlm.step()).decode('ascii')}
            connection.request('POST', '/EWS/Exchange.asmx', body=payload, headers=headers)
            response = connection.getresponse()
            offered = response.headers.get_all('WWW-Authenticate', [])
            status = response.status
            if len(response.read(1024 * 1024 + 1)) > 1024 * 1024:
                raise RuntimeError('ntlm_response_limit')
            challenge = next((v[5:] for v in offered if v.startswith('NTLM ')), None)
            if status != 401 or not challenge or connection.sock is None:
                raise RuntimeError('ntlm_negotiate_failed')
            headers['Authorization'] = 'NTLM ' + base64.b64encode(ntlm.step(base64.b64decode(challenge, validate=True))).decode('ascii')
            connection.request('POST', '/EWS/Exchange.asmx', body=payload, headers=headers)
            headers.clear()
            response = connection.getresponse()
            data = response.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                raise RuntimeError('ews_response_limit')
            if response.status != 200:
                raise RuntimeError('ews_http_' + str(response.status))
            if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
                raise RuntimeError('ews_response_invalid')
            validate_create_response(data)
        finally:
            connection.close()


def atomic_receipt(filename, value):
    directory = str(Path(filename).parent)
    fd, temporary = tempfile.mkstemp(prefix='.receipt-', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, str(filename))
        if os.name != 'nt':
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Dispatcher:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name != 'nt' and self.root.stat().st_mode & 0o077:
            raise RuntimeError('receipt_directory_permissions')
        self.lock = threading.Lock()

    def send(self, runtime, request):
        if not isinstance(request, dict) or set(request) != {'configurationRevision', 'message'}:
            raise RuntimeError('request_invalid')
        if request['configurationRevision'] != runtime['revision']:
            raise RuntimeError('configuration_changed')
        message = validate_message(request['message'], runtime['account'])
        request_hash = hashlib.sha256(json.dumps(message, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
        filename = self.root / (hashlib.sha256(message['messageId'].encode('utf-8')).hexdigest() + '.json')
        with self.lock:
            if filename.exists():
                prior = json.loads(private_bytes(str(filename)).decode('utf-8'))
                if prior['requestHash'] != request_hash:
                    raise RuntimeError('message_id_conflict')
                return {'accepted': prior['state'] == 'sent', 'state': 'unknown' if prior['state'] == 'sending' else prior['state'], 'messageId': message['messageId']}
            receipt = {'requestHash': request_hash, 'state': 'sending', 'messageId': message['messageId']}
            atomic_receipt(filename, receipt)
        try:
            runtime['sender'].send(message)
            receipt['state'] = 'sent'
        except DeliveryRejected:
            receipt['state'] = 'failed'
        except Exception:
            # No protocol retry: a closed socket/timeout could follow successful Exchange acceptance.
            receipt['state'] = 'unknown'
        atomic_receipt(filename, receipt)
        return {'accepted': receipt['state'] == 'sent', 'state': receipt['state'], 'messageId': message['messageId']}


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'RecruitEwsBridge'

    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def answer(self, status, value):
        data = json.dumps(value).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)

    def handle_request(self, sending=False):
        try:
            config = settings(self.server.config_file)
            token = private_bytes(config['tokenFile'], 200).decode('ascii').strip()
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.answer(403, {'state': 'failed', 'error': 'unauthorized'})
                return
            runtime = load_runtime(config)
            if not sending and self.path == '/status':
                self.answer(200, {'ready': True, 'account': runtime['account'], 'recipient': RECIPIENT, 'singleRecipientReplies': True, 'configurationRevision': runtime['revision']})
                return
            if not sending or self.path != '/send' or self.headers.get('Transfer-Encoding'):
                self.answer(404, {'state': 'failed', 'error': 'route_invalid'})
                return
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_REQUEST:
                self.answer(413, {'state': 'failed', 'error': 'request_limit'})
                return
            data = self.rfile.read(length)
            if len(data) != length:
                raise RuntimeError('request_incomplete')
            result = self.server.dispatcher.send(runtime, json.loads(data.decode('utf-8')))
            self.answer(200, result)
        except Exception:
            # Never return credentials, raw headers, XML server text, or exception details.
            self.answer(503, {'state': 'unknown', 'error': 'bridge_request_failed'})

    def do_GET(self):
        self.handle_request(False)

    def do_POST(self):
        self.handle_request(True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--check', action='store_true', help='Read-only GetFolder authentication check; never sends')
    args = parser.parse_args()
    if os.geteuid() == 0:
        raise RuntimeError('non_root_service_required')
    config = settings(args.config)
    runtime = load_runtime(config)
    if args.check:
        runtime['sender'].check()
        print(json.dumps({'ready': True, 'protocol': 'EWS', 'recipient': RECIPIENT, 'authentication': 'NTLMv2-channel-binding-pinned-TLS'}))
        return
    import fcntl
    os.umask(0o077)
    dispatcher = Dispatcher(config['receiptRoot'])
    process_lock = (dispatcher.root / '.bridge.lock').open('a')
    # A second process must never unlink the live socket or race persistent send claims.
    fcntl.flock(process_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    socket_path = Path(config['socketPath'])
    socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if socket_path.exists():
        info = socket_path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid():
            raise RuntimeError('socket_path_invalid')
        socket_path.unlink()
    server = socketserver.UnixStreamServer(str(socket_path), Handler)
    os.chmod(str(socket_path), 0o600)
    server.config_file = args.config
    server.dispatcher = dispatcher
    try:
        server.serve_forever()
    finally:
        server.server_close()
        socket_path.unlink()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'ready': False, 'error': 'bridge_stopped'}))
        raise SystemExit(1)
