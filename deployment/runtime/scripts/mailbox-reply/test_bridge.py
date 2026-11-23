import base64
import copy
import hashlib
import json
import os
import ssl
import tempfile
import types
import unittest
from email.parser import BytesParser
from pathlib import Path
from unittest import mock
import bridge


def message():
    return {'from': {'name': '合成HR', 'address': 'hr@sensteed.com'}, 'to': bridge.RECIPIENT,
            'subject': '[模板测试] 合成测试', 'text': '合成正文\n第二行',
            'messageId': '<00000000-0000-4000-8000-000000000001@sensteed.com>',
            'inReplyTo': '<original@source.invalid>', 'references': ['<prior@source.invalid>', '<original@source.invalid>']}


class BridgeTests(unittest.TestCase):
    def test_named_https_link_mime_preserves_plain_text_and_clickable_html(self):
        value = message()
        url = 'https://www.16personality.com.cn/#version=48'
        label = 'MBTI十六型人格免费测试 - 专业深度测评平台 | 16personalities'
        value['text'] = '第一行\n没做过：链接：[' + label + '](' + url + ')，请抽空完成。'
        parsed = BytesParser(policy=bridge.email.policy.default).parsebytes(bridge.mime_bytes(value, 'hr@sensteed.com'))
        self.assertEqual(parsed.get_content_type(), 'multipart/alternative')
        self.assertEqual(parsed.get_body(preferencelist=('plain',)).get_content().replace('\r\n', '\n').rstrip(),
                         '第一行\n没做过：链接：' + label + ' (' + url + ')，请抽空完成。')
        self.assertIn('<a href="' + url + '">' + label + '</a>', parsed.get_body(preferencelist=('html',)).get_content())
        self.assertNotIn(b'\r\r', bridge.mime_bytes(value, 'hr@sensteed.com'))

    def test_html_is_escaped_and_only_named_https_links_are_formatted(self):
        plain, rich = bridge.reply_body('<img src=x onerror=alert(1)>\r\n[A & B](https://example.test/?a=1&b=2) [bad](javascript:alert(1)) [bad](https://x.test/"bad)')
        self.assertIn('&lt;img src=x onerror=alert(1)&gt;<br>', rich)
        self.assertIn('<a href="https://example.test/?a=1&amp;b=2">A &amp; B</a>', rich)
        self.assertEqual(rich.count('<a '), 1)
        self.assertNotIn('<img', rich)
        self.assertEqual(bridge.reply_body('普通邮件\n第二行'), ('普通邮件\n第二行', None))

    def test_mime_has_only_fixed_recipient_and_preserves_utf8_and_thread(self):
        data = bridge.mime_bytes(message(), 'hr@sensteed.com')
        parsed = BytesParser(policy=bridge.email.policy.default).parsebytes(data)
        self.assertEqual(str(parsed['To']), bridge.RECIPIENT)
        self.assertIsNone(parsed['Cc'])
        self.assertIsNone(parsed['Bcc'])
        self.assertEqual(str(parsed['Subject']), message()['subject'])
        self.assertEqual(str(parsed['In-Reply-To']), message()['inReplyTo'])
        self.assertEqual(str(parsed['References']), ' '.join(message()['references']))
        self.assertEqual(parsed.get_content().replace('\r\n', '\n').rstrip(), message()['text'])

    def test_message_rejects_recipient_spoofing_unreplaced_fields_and_header_injection(self):
        for update in [{'to': 'other@sensteed.com'}, {'cc': bridge.RECIPIENT}, {'subject': '[模板测试] x\r\nBcc: x@evil.test'},
                       {'text': '{候选人姓名}'}, {'inReplyTo': '<x@source.invalid>\r\nBcc: x@evil.test'}, {'messageId': '<bad\x00@source.invalid>'},
                       {'from': {'name': 'HR', 'address': 'other@sensteed.com'}}, {'references': '<not-an-array@x.invalid>'}]:
            bad = message()
            bad.update(update)
            with self.assertRaises(RuntimeError):
                bridge.validate_message(bad, 'hr@sensteed.com')

    def test_production_single_recipient_mime_and_xml_escaping(self):
        value = message()
        value.update(to='a&b@personal.com', subject='面试邀约')
        parsed = BytesParser(policy=bridge.email.policy.default).parsebytes(bridge.mime_bytes(value, 'hr@sensteed.com'))
        self.assertEqual(str(parsed['To']), 'a&b@personal.com')
        self.assertEqual(str(parsed['X-Recruit-Template-Test']), 'false')
        sender = bridge.EwsSender(types.SimpleNamespace(config={'account': 'hr@sensteed.com'}))
        sender._create = mock.Mock()
        sender.send(value)
        self.assertIn('a&amp;b@personal.com', sender._create.call_args[0][0])
        for address in ['a@personal.com,b@personal.com', 'a@personal.com\r\nBcc:x@personal.com']:
            with self.assertRaises(RuntimeError):
                bridge.mime_bytes(dict(value, to=address), 'hr@sensteed.com')

    def test_malformed_create_response_is_unknown_and_not_safe_to_retry(self):
        for body in ['<m:CreateItemResponse/>', '<m:CreateItemResponse><m:ResponseCode>NoError</m:ResponseCode></m:CreateItemResponse>', '<m:CreateItemResponse><m:CreateItemResponseMessage ResponseClass="Error"/></m:CreateItemResponse>']:
            data = ('<root xmlns:m="' + bridge.NS['m'] + '">' + body + '</root>').encode()
            with self.assertRaises(RuntimeError) as caught:
                bridge.validate_create_response(data)
            self.assertNotIsInstance(caught.exception, bridge.DeliveryRejected)
        self.assertNotIn(b'\r\r', bridge.mime_bytes(message(), 'hr@sensteed.com'))

    def test_durable_claim_survives_duplicate_restart_and_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            sender = mock.Mock()
            runtime = {'revision': 'a' * 64, 'account': 'hr@sensteed.com', 'sender': sender}
            request = {'configurationRevision': runtime['revision'], 'message': message()}
            dispatcher = bridge.Dispatcher(str(Path(directory) / 'receipts'))
            def accepted(_):
                files = list(dispatcher.root.glob('*.json'))
                self.assertEqual(json.loads(files[0].read_text())['state'], 'sending')
            sender.send.side_effect = accepted
            self.assertTrue(dispatcher.send(runtime, request)['accepted'])
            self.assertTrue(bridge.Dispatcher(str(dispatcher.root)).send(runtime, request)['accepted'])
            self.assertEqual(sender.send.call_count, 1)
            changed = copy.deepcopy(request)
            changed['message']['text'] = 'different'
            with self.assertRaisesRegex(RuntimeError, 'message_id_conflict'):
                dispatcher.send(runtime, changed)
            request['message']['messageId'] = '<uncertain@sensteed.com>'
            sender.send.side_effect = TimeoutError('synthetic secret must not leak')
            self.assertEqual(dispatcher.send(runtime, request)['state'], 'unknown')
            self.assertEqual(bridge.Dispatcher(str(dispatcher.root)).send(runtime, request)['state'], 'unknown')
            self.assertEqual(sender.send.call_count, 2)
            self.assertNotIn('synthetic secret', ''.join(f.read_text() for f in dispatcher.root.glob('*.json')))
            request['configurationRevision'] = 'b' * 64
            with self.assertRaisesRegex(RuntimeError, 'configuration_changed'):
                dispatcher.send(runtime, request)

    def test_ews_uses_ntlmv2_channel_binding_certificate_pin_and_no_retry(self):
        certificate = b'synthetic DER certificate'
        readonly = types.SimpleNamespace(config={'host': 'mail.test', 'account': 'hr@sensteed.com', 'certificate': '/private/cert.pem', 'username': 'hr', 'password': 'synthetic', 'domain': 'TEST'}, fingerprint=hashlib.sha256(certificate).digest())
        context = types.SimpleNamespace(check_hostname=True, verify_mode=ssl.CERT_REQUIRED, verify_flags=0)
        bindings = type('Bindings', (dict,), {'APPLICATION_DATA': 'application_data'})
        ntlm = mock.Mock()
        ntlm.step.side_effect = [b'type1', b'type3']
        ntlm_factory = mock.Mock(return_value=ntlm)
        first = mock.Mock(status=401)
        first.headers.get_all.return_value = ['NTLM ' + base64.b64encode(b'type2').decode('ascii')]
        first.read.return_value = b''
        second = mock.Mock(status=200)
        second.read.return_value = ('<m:CreateItemResponse xmlns:m="' + bridge.NS['m'] + '"><m:ResponseMessages><m:CreateItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode></m:CreateItemResponseMessage></m:ResponseMessages></m:CreateItemResponse>').encode()
        connection = mock.Mock()
        connection.sock.getpeercert.return_value = certificate
        connection.getresponse.side_effect = [first, second]
        modules = {'ntlm_auth': types.ModuleType('ntlm_auth'), 'ntlm_auth.ntlm': types.SimpleNamespace(NtlmContext=ntlm_factory), 'ntlm_auth.gss_channel_bindings': types.SimpleNamespace(GssChannelBindingsStruct=bindings)}
        with mock.patch.dict('sys.modules', modules), mock.patch.object(bridge.ssl, 'create_default_context', return_value=context), mock.patch.object(bridge.http.client, 'HTTPSConnection', return_value=connection) as factory:
            bridge.EwsSender(readonly).send(message())
            factory.assert_called_once_with('mail.test', 443, context=context, timeout=15)
            self.assertEqual(ntlm_factory.call_args[1]['ntlm_compatibility'], 3)
            self.assertEqual(ntlm_factory.call_args[1]['cbt_data']['application_data'], b'tls-server-end-point:' + readonly.fingerprint)
            self.assertEqual(connection.request.call_count, 2)
            payload = connection.request.call_args[1]['body'].decode()
            self.assertIn('MessageDisposition="SendAndSaveCopy"', payload)
            self.assertIn('<t:EmailAddress>' + bridge.RECIPIENT, payload)
            self.assertNotIn('synthetic', payload)
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            connection.close.assert_called_once()
        connection.reset_mock()
        connection.sock.getpeercert.return_value = b'wrong-certificate'
        with mock.patch.dict('sys.modules', modules), mock.patch.object(bridge.ssl, 'create_default_context', return_value=context), mock.patch.object(bridge.http.client, 'HTTPSConnection', return_value=connection):
            with self.assertRaisesRegex(RuntimeError, 'server_certificate_mismatch'):
                bridge.EwsSender(readonly).send(message())
            self.assertEqual(connection.request.call_count, 0)
        connection.reset_mock()
        context.check_hostname = False
        with mock.patch.dict('sys.modules', modules), mock.patch.object(bridge.ssl, 'create_default_context', return_value=context), mock.patch.object(bridge.http.client, 'HTTPSConnection', return_value=connection):
            with self.assertRaisesRegex(RuntimeError, 'tls_verification_required'):
                bridge.EwsSender(readonly).send(message())
            self.assertEqual(connection.request.call_count, 0)
        context.check_hostname = True
        connection.sock.getpeercert.return_value = certificate
        ntlm.step.side_effect = [b'type1', b'type3']
        second.read.return_value = ('<m:CreateItemResponse xmlns:m="' + bridge.NS['m'] + '"><m:ResponseMessages><m:CreateItemResponseMessage ResponseClass="Error"><m:ResponseCode>ErrorAccessDenied</m:ResponseCode></m:CreateItemResponseMessage></m:ResponseMessages></m:CreateItemResponse>').encode()
        connection.getresponse.side_effect = [first, second]
        with mock.patch.dict('sys.modules', modules), mock.patch.object(bridge.ssl, 'create_default_context', return_value=context), mock.patch.object(bridge.http.client, 'HTTPSConnection', return_value=connection):
            with self.assertRaisesRegex(RuntimeError, '^ews_response_rejected$'):
                bridge.EwsSender(readonly).send(message())
            self.assertEqual(connection.request.call_count, 2, 'EWS errors must not trigger automatic authentication or delivery retries')

    @unittest.skipIf(os.name == 'nt', 'Unix socket integration uses the Linux validation container')
    def test_private_socket_auth_limits_and_duplicate_request(self):
        import http.client
        import socket
        import socketserver
        import threading
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / 'token'
            token_file.write_text('a' * 64)
            token_file.chmod(0o600)
            config = {'tokenFile': str(token_file)}
            sender = mock.Mock()
            runtime = {'token': 'a' * 64, 'revision': 'b' * 64, 'account': 'hr@sensteed.com', 'sender': sender}
            socket_path = str(Path(directory) / 'bridge.sock')
            server = socketserver.UnixStreamServer(socket_path, bridge.Handler)
            server.config_file = '/synthetic/config.json'
            server.dispatcher = bridge.Dispatcher(str(Path(directory) / 'receipts'))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def request(route, body=None, token='a' * 64, length=None):
                connection = http.client.HTTPConnection('localhost', timeout=2)
                connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                connection.sock.connect(socket_path)
                payload = json.dumps(body).encode() if body is not None else None
                headers = {'Authorization': 'Bearer ' + token}
                if length is not None:
                    headers['Content-Length'] = str(length)
                connection.request('POST' if body is not None else 'GET', route, body=payload, headers=headers)
                response = connection.getresponse()
                result = response.status, json.loads(response.read())
                connection.close()
                return result
            try:
                with mock.patch.object(bridge, 'settings', return_value=config), mock.patch.object(bridge, 'load_runtime', return_value=runtime):
                    self.assertEqual(request('/status', token='wrong')[0], 403)
                    self.assertEqual(request('/status')[1]['configurationRevision'], runtime['revision'])
                    payload = {'configurationRevision': runtime['revision'], 'message': message()}
                    self.assertEqual(request('/send', payload, length=bridge.MAX_REQUEST + 1)[0], 413)
                    self.assertTrue(request('/send', payload)[1]['accepted'])
                    self.assertTrue(request('/send', payload)[1]['accepted'])
                    self.assertEqual(sender.send.call_count, 1)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
