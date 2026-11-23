"""Read-only mailbox synchronization and atomic private archives (Python 3.6+)."""
import argparse
import datetime
import email.policy
import email.utils
import fcntl
import getpass
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path
from ews import Ews

MAX_MAIL = 64 * 1024 * 1024


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix='.write-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, str(path))
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


class TextHTML(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.parts, self.ignored = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'head'):
            self.ignored += 1
        if tag in ('p', 'br', 'div', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3') and not self.ignored:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'head'):
            self.ignored = max(0, self.ignored - 1)
        if tag in ('p', 'div', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3') and not self.ignored:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.ignored:
            self.parts.append(re.sub(r'\s+', ' ', data))


def html_text(value):
    parser = TextHTML()
    parser.feed(value)
    return '\n'.join(line.strip() for line in ''.join(parser.parts).splitlines() if line.strip())


def archive_message(root, mailbox_id, item_id, raw, received_at):
    if not raw or len(raw) > MAX_MAIL:
        raise RuntimeError('mail_size_limit')
    parsed = BytesParser(policy=email.policy.default).parsebytes(raw)
    identity = str(parsed.get('Message-ID', '')).strip() or item_id
    key = hashlib.sha256((mailbox_id + '\0' + identity).encode('utf-8')).hexdigest()
    destination = Path(root) / 'messages' / key
    if (destination / 'message.json').is_file():
        return json.loads((destination / 'message.json').read_text(encoding='utf-8'))
    body_part = parsed.get_body(preferencelist=('plain', 'html'))
    body_warning = ''
    try:
        body = body_part.get_content() if body_part else ''
    except (LookupError, UnicodeError):
        body = (body_part.get_payload(decode=True) or b'').decode('utf-8', errors='replace')
        body_warning = '邮件正文的编码无法识别，已作兼容解码；请下载原邮件核对。'
    if not isinstance(body, str):
        body = ''
    if body_part and body_part.get_content_subtype() == 'html':
        body = html_text(body)
    attachments, payloads = [], []
    for part in parsed.walk():
        if part.is_multipart():
            continue
        original_name = part.get_filename()
        disposition = part.get_content_disposition()
        if not original_name and disposition != 'attachment':
            continue
        if len(attachments) >= 200:
            raise RuntimeError('attachment_count_limit')
        name = str(original_name or 'attachment').replace('\\', '/').rsplit('/', 1)[-1]
        name = re.sub(r'[\r\n\x00]', '', name)[:200] or 'attachment'
        data = part.get_payload(decode=True) or b''
        attachment_id = str(len(attachments))
        file_name = 'attachment-' + attachment_id
        inline = disposition == 'inline'
        importable = not inline and Path(name).suffix.lower() in ('.pdf', '.docx', '.txt') and 0 < len(data) <= 10 * 1024 * 1024
        attachments.append({'id': attachment_id, 'name': name, 'file': file_name, 'size': len(data),
                            'sha256': hashlib.sha256(data).hexdigest(), 'contentType': part.get_content_type(),
                            'inline': inline, 'importable': importable})
        payloads.append((file_name, data))
    sender_name, sender_email = email.utils.parseaddr(str(parsed.get('From', '')))
    if not received_at:
        try:
            received_at = email.utils.parsedate_to_datetime(str(parsed.get('Date', ''))).isoformat()
        except (ValueError, TypeError, AttributeError):
            received_at = now()
    metadata = {'id': key, 'mailboxId': mailbox_id, 'subject': str(parsed.get('Subject', ''))[:2000],
                'senderName': sender_name[:500], 'senderEmail': sender_email[:500],
                'receivedAt': received_at, 'archivedAt': now(), 'messageId': identity[:2000],
                'rawSize': len(raw), 'rawSha256': hashlib.sha256(raw).hexdigest(),
                'body': body[:1024 * 1024], 'bodyWarning': body_warning, 'attachments': attachments}
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = Path(tempfile.mkdtemp(prefix='.mail-', dir=str(destination.parent)))
    try:
        for name, data in [('original.eml', raw)] + payloads:
            fd = os.open(str(temp / name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        atomic_json(temp / 'message.json', metadata)
        os.rename(str(temp), str(destination))
    finally:
        if temp.exists():
            shutil.rmtree(str(temp))
    return metadata


def received_in_scope(received_at, received_since=None):
    if not received_since:
        return True
    def instant(value):
        try:
            # Production runs Python 3.6; fromisoformat is unavailable.
            normalized = re.sub(r'([+-]\d{2}):(\d{2})$', r'\1\2', value.replace('Z', '+0000'))
            fmt = '%Y-%m-%dT%H:%M:%S.%f%z' if '.' in normalized else '%Y-%m-%dT%H:%M:%S%z'
            return datetime.datetime.strptime(normalized, fmt)
        except (ValueError, TypeError, AttributeError):
            raise RuntimeError('invalid_mailbox_received_date')
    return instant(received_at) >= instant(received_since)


def rebuild_index(root, received_since=None):
    items = []
    for path in (Path(root) / 'messages').glob('*/message.json'):
        message = json.loads(path.read_text(encoding='utf-8'))
        if not received_in_scope(message.get('receivedAt'), received_since):
            continue
        items.append({k: message[k] for k in ('id', 'mailboxId', 'subject', 'senderName', 'senderEmail', 'receivedAt', 'attachments')})
    items.sort(key=lambda value: value['receivedAt'], reverse=True)
    atomic_json(Path(root) / 'index.json', items)
    return len(items)


def synchronize(client, root, mailbox_id, account, request_id=None, received_since=None):
    if received_since:
        received_in_scope(received_since, received_since)
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_file = root / 'state.json'
    state = json.loads(state_file.read_text()) if state_file.exists() else {'cursor': None, 'items': {}}
    started = now()
    previous_status = json.loads((root / 'status.json').read_text()) if (root / 'status.json').exists() else {}
    request_id = request_id or previous_status.get('lastRequestId')
    count = 0
    for batch_number in range(100):
        atomic_json(root / 'status.json', {'id': mailbox_id, 'account': account, 'state': 'syncing',
                    'startedAt': started, 'updatedAt': now(), 'messageCount': rebuild_index(root, received_since), 'lastRequestId': request_id})
        try:
            batch = client.sync(state['cursor'])
        except RuntimeError as exc:
            if str(exc) == 'ews_ErrorInvalidSyncStateData' and state['cursor']:
                state['cursor'] = None
                batch = client.sync(None)
            else:
                raise
        for kind, item_id in batch['items']:
            key = state['items'].get(item_id)
            if key and (root / 'messages' / key / 'message.json').is_file():
                continue
            raw, received_at = client.fetch(item_id)
            if not received_in_scope(received_at, received_since):
                continue
            metadata = archive_message(root, mailbox_id, item_id, raw, received_at)
            state['items'][item_id] = metadata['id']
            count += 1
        if not batch['cursor']:
            raise RuntimeError('sync_cursor_missing')
        state['cursor'] = batch['cursor']
        atomic_json(state_file, state)
        total = rebuild_index(root, received_since)
        atomic_json(root / 'status.json', {'id': mailbox_id, 'account': account,
                    'state': 'syncing' if batch['more'] else 'ready', 'startedAt': started,
                    'lastSyncedAt': now(), 'updatedAt': now(), 'messageCount': total, 'lastRequestId': request_id})
        if not batch['more']:
            return total, count
    return rebuild_index(root, received_since), count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--setup', action='store_true')
    parser.add_argument('--root')
    parser.add_argument('--certificate')
    parser.add_argument('--dependencies')
    parser.add_argument('--account')
    parser.add_argument('--username')
    args = parser.parse_args()
    config_path = Path(args.config)
    if args.setup:
        if not sys.stdin.isatty() or config_path.exists():
            raise RuntimeError('interactive_new_configuration_required')
        password = getpass.getpass('Recruitment mailbox password (hidden input): ')
        cert = Path(args.certificate)
        config = {'host': 'mail.sensteed.local', 'domain': 'SENSTEED', 'id': 'recruitment',
                  'account': args.account, 'username': args.username, 'password': password,
                  'root': args.root, 'certificate': str(cert), 'dependencyPath': args.dependencies,
                  'certificateSha256': hashlib.sha256(__import__('ssl').PEM_cert_to_DER_cert(cert.read_text())).hexdigest()}
        Ews(config).call('GetFolder', '<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds><t:DistinguishedFolderId Id="inbox"/></m:FolderIds></m:GetFolder>')
        atomic_json(config_path, config)
        print('Mailbox configuration saved with private permissions.', flush=True)
        return
    if config_path.stat().st_mode & 0o077:
        raise RuntimeError('configuration_permissions_too_broad')
    config = json.loads(config_path.read_text(encoding='utf-8'))
    root = Path(config['root'])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (root / '.sync.lock').open('a')
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    client = Ews(config)
    while True:
        request = root / 'sync.request'
        request_id = None
        if request.exists():
            request_id = request.read_text().strip()
            request.unlink()
        try:
            total, fetched = synchronize(client, root, config['id'], config['account'], request_id, config.get('receivedSince'))
            if request_id and re.match(r'^[a-f0-9-]{36}$', request_id):
                atomic_json(root / 'requests' / (request_id + '.json'), {'requestId': request_id, 'completedAt': now(), 'messageCount': total})
            print(json.dumps({'event': 'sync_complete', 'total': total, 'fetched': fetched}), flush=True)
        except Exception as exc:
            error = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
            old = json.loads((root / 'status.json').read_text()) if (root / 'status.json').exists() else {}
            old.update(id=config['id'], account=config['account'], state='error', updatedAt=now(), error=error)
            atomic_json(root / 'status.json', old)
            print(json.dumps({'event': 'sync_failed', 'error': error}), flush=True)
            if args.once:
                return 1
            if error in ('ews_http_401', 'ews_http_403'):
                # A rotated/revoked password must not be retried until configuration changes.
                blocked_mtime = config_path.stat().st_mtime_ns
                while config_path.stat().st_mtime_ns == blocked_mtime:
                    time.sleep(5)
                if config_path.stat().st_mode & 0o077:
                    raise RuntimeError('configuration_permissions_too_broad')
                config = json.loads(config_path.read_text(encoding='utf-8'))
                client = Ews(config)
                continue
        if args.once:
            return 0
        for second in range(60):
            if request.exists():
                break
            time.sleep(1)


if __name__ == '__main__':
    try:
        sys.exit(main() or 0)
    except (KeyboardInterrupt, EOFError):
        sys.exit(2)
    except Exception as exc:
        print(json.dumps({'event': 'stopped', 'error': str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__}), flush=True)
        sys.exit(1)
