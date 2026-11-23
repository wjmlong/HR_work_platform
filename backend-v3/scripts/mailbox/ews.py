"""Small, pinned-certificate EWS/NTLMv2 client. No credentials are logged."""
import base64
import hashlib
import http.client
import ssl
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

NS = {'m': 'http://schemas.microsoft.com/exchange/services/2006/messages',
      't': 'http://schemas.microsoft.com/exchange/services/2006/types'}
MAX_RESPONSE = 96 * 1024 * 1024


class Ews:
    def __init__(self, config):
        self.config = config
        if config.get('dependencyPath'):
            sys.path.insert(0, config['dependencyPath'])
        self.cert = Path(config['certificate']).read_text()
        self.fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(self.cert)).digest()
        if self.fingerprint.hex() != config['certificateSha256'].lower():
            raise RuntimeError('certificate_file_mismatch')

    def call(self, operation, body):
        if operation not in ('GetFolder', 'SyncFolderItems', 'GetItem'):
            raise RuntimeError('read_only_operation_required')
        from ntlm_auth.ntlm import NtlmContext
        from ntlm_auth.gss_channel_bindings import GssChannelBindingsStruct
        ctx = ssl.create_default_context(cafile=self.config['certificate'])
        # OpenSSL 1.0.2k's X509_V_FLAG_PARTIAL_CHAIN. Trust only the supplied leaf.
        ctx.verify_flags |= getattr(ssl, 'VERIFY_X509_PARTIAL_CHAIN', 0x80000)
        assert ctx.check_hostname and ctx.verify_mode == ssl.CERT_REQUIRED
        connection = http.client.HTTPSConnection(self.config['host'], 443, context=ctx, timeout=30)
        try:
            connection.connect()
            if hashlib.sha256(connection.sock.getpeercert(binary_form=True)).digest() != self.fingerprint:
                raise RuntimeError('server_certificate_mismatch')
            cbt = GssChannelBindingsStruct()
            cbt[cbt.APPLICATION_DATA] = b'tls-server-end-point:' + self.fingerprint
            ntlm = NtlmContext(self.config['username'], self.config['password'],
                               domain=self.config['domain'], cbt_data=cbt, ntlm_compatibility=3)
            payload = ('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
                       'xmlns:m="' + NS['m'] + '" xmlns:t="' + NS['t'] + '">'
                       '<s:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></s:Header>'
                       '<s:Body>' + body + '</s:Body></s:Envelope>').encode('utf-8')
            headers = {'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': NS['m'] + '/' + operation,
                       'Authorization': 'NTLM ' + base64.b64encode(ntlm.step()).decode('ascii')}
            connection.request('POST', '/EWS/Exchange.asmx', body=payload, headers=headers)
            response = connection.getresponse()
            offered = response.headers.get_all('WWW-Authenticate', [])
            status = response.status
            response.read(1024 * 1024)
            challenge = next((v[5:] for v in offered if v.startswith('NTLM ')), None)
            if status != 401 or not challenge or connection.sock is None:
                raise RuntimeError('ntlm_negotiate_failed')
            headers['Authorization'] = 'NTLM ' + base64.b64encode(ntlm.step(base64.b64decode(challenge))).decode('ascii')
            connection.request('POST', '/EWS/Exchange.asmx', body=payload, headers=headers)
            headers.clear()
            response = connection.getresponse()
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise RuntimeError('mail_response_too_large')
            if response.status != 200:
                raise RuntimeError('ews_http_' + str(response.status))
            root = ET.fromstring(data)
            codes = [node.text for node in root.findall('.//m:ResponseCode', NS)]
            if not codes or any(code != 'NoError' for code in codes):
                # Return only protocol codes, never server-supplied text or credentials.
                code = next((code for code in codes if code != 'NoError'), 'invalid_response')
                raise RuntimeError('ews_' + code)
            return root
        finally:
            connection.close()

    def sync(self, cursor):
        state = '<m:SyncState>' + escape(cursor) + '</m:SyncState>' if cursor else ''
        root = self.call('SyncFolderItems', '<m:SyncFolderItems>'
                         '<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>'
                         '<m:SyncFolderId><t:DistinguishedFolderId Id="inbox"/></m:SyncFolderId>' + state +
                         '<m:MaxChangesReturned>25</m:MaxChangesReturned>'
                         '<m:SyncScope>NormalItems</m:SyncScope></m:SyncFolderItems>')
        changes = root.find('.//m:Changes', NS)
        items = []
        for change in changes if changes is not None else []:
            kind = change.tag.rsplit('}', 1)[-1]
            item = change.find('.//t:ItemId', NS)
            if kind in ('Create', 'Update') and item is not None:
                items.append((kind, item.attrib['Id']))
        return {'cursor': root.findtext('.//m:SyncState', namespaces=NS),
                'more': root.findtext('.//m:IncludesLastItemInRange', namespaces=NS) != 'true', 'items': items}

    def fetch(self, item_id):
        root = self.call('GetItem', '<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>'
                         '<t:IncludeMimeContent>true</t:IncludeMimeContent><t:AdditionalProperties>'
                         '<t:FieldURI FieldURI="item:DateTimeReceived"/></t:AdditionalProperties>'
                         '</m:ItemShape><m:ItemIds><t:ItemId Id=' + quoteattr(item_id) + '/></m:ItemIds></m:GetItem>')
        content = root.findtext('.//t:MimeContent', namespaces=NS)
        if not content:
            raise RuntimeError('mail_mime_missing')
        return base64.b64decode(content, validate=True), root.findtext('.//t:DateTimeReceived', namespaces=NS)
