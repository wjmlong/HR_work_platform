import unittest, tempfile, hashlib
from pathlib import Path
from email.message import EmailMessage
from sync import archive_message, synchronize, html_text, received_in_scope, rebuild_index

class SyncTests(unittest.TestCase):
    def test_cutoff_is_inclusive_and_timezone_aware(self):
        cutoff='2026-11-01T00:00:00+08:00'
        self.assertFalse(received_in_scope('2026-10-31T15:59:59Z',cutoff))
        self.assertTrue(received_in_scope('2026-10-31T16:00:00Z',cutoff))
        self.assertTrue(received_in_scope('2026-11-01T00:00:00+08:00',cutoff))
        for bad in ['',None,'unknown','2026-11-01T00:00:00']:
            with self.assertRaisesRegex(RuntimeError,'invalid_mailbox_received_date'):
                received_in_scope(bad,cutoff)
    def test_cutoff_filters_existing_index_without_deleting_original(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);raw=self.mail()
            old=archive_message(root,'recruitment','old',raw,'2026-10-30T00:00:00Z')
            self.assertEqual(rebuild_index(root,'2026-11-01T00:00:00+08:00'),0)
            self.assertEqual((root/'messages'/old['id']/'original.eml').read_bytes(),raw)
            self.assertEqual(rebuild_index(root),1)
    def test_cutoff_skips_old_fetch_but_advances_cursor(self):
        raw=self.mail()
        class Client:
            def sync(self,cursor):return {'cursor':'next','more':False,'items':[('Create','old'),('Create','new')]} if not cursor else {'cursor':'next','more':False,'items':[]}
            def fetch(self,item):return raw,('2026-10-31T15:59:59Z' if item=='old' else '2026-10-31T16:00:00Z')
        with tempfile.TemporaryDirectory() as d:
            import json
            root=Path(d);cutoff='2026-11-01T00:00:00+08:00'
            self.assertEqual(synchronize(Client(),root,'recruitment','recruit@example.invalid',received_since=cutoff),(1,1))
            state=json.loads((root/'state.json').read_text())
            self.assertEqual(state['cursor'],'next');self.assertNotIn('old',state['items'])
            self.assertEqual(synchronize(Client(),root,'recruitment','recruit@example.invalid',received_since=cutoff),(1,0))
    def test_transport_refuses_all_write_operations(self):
        from ews import Ews
        client=Ews.__new__(Ews)
        for operation in ['CreateItem','SendItem','UpdateItem','DeleteItem','MoveItem']:
            with self.assertRaisesRegex(RuntimeError,'read_only_operation_required'):
                client.call(operation,'')
    def mail(self):
        m=EmailMessage();m['From']='applicant@example.invalid';m['To']='recruit@example.invalid';m['Subject']='Synthetic application';m['Message-ID']='<synthetic@example.invalid>';m.set_content('Synthetic application body');m.add_attachment(b'Synthetic resume',maintype='application',subtype='pdf',filename='../resume.pdf');return m.as_bytes()
    def test_archive_preserves_raw_and_attachments_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);raw=self.mail();a=archive_message(root,'recruitment','item-1',raw,'2026-11-05T00:00:00Z');b=archive_message(root,'recruitment','item-2',raw,'2026-11-05T00:00:00Z')
            self.assertEqual(a['id'],b['id']);self.assertEqual(len(list((root/'messages').iterdir())),1);self.assertEqual((root/'messages'/a['id']/'original.eml').read_bytes(),raw)
            att=a['attachments'][0];self.assertEqual(att['name'],'resume.pdf');self.assertEqual((root/'messages'/a['id']/att['file']).read_bytes(),b'Synthetic resume')
    def test_html_layout_whitespace_is_not_resume_content(self):
        raw='<html><head><title>通知</title></head><body>\n   <div>林女士</div>\n <table><tr><td>&nbsp; </td></tr><tr><td>个人优势</td></tr><tr><td>熟悉薪酬管理</td></tr></table><script>bad()</script></body></html>'
        text=html_text(raw)
        self.assertEqual(text,'林女士\n个人优势\n熟悉薪酬管理')
    def test_html_drops_active_content(self):
        text=html_text('<p>Hello</p><script>secret()</script><style>bad</style><img src="https://example.invalid/track"><p>World</p>')
        self.assertIn('Hello',text);self.assertIn('World',text);self.assertNotIn('secret',text);self.assertNotIn('track',text)
    def test_unknown_charset_preserves_original_and_decodes_body_without_blocking(self):
        raw=b'From: applicant@example.invalid\r\nMessage-ID: <odd@example.invalid>\r\nContent-Type: text/plain; charset=x-nonexistent-charset\r\n\r\nSynthetic application body'
        with tempfile.TemporaryDirectory() as d:
            value=archive_message(Path(d),'recruitment','odd',raw,'2026-11-05T00:00:00Z')
            self.assertEqual((Path(d)/'messages'/value['id']/'original.eml').read_bytes(),raw)
            self.assertIn('Synthetic application',value['body'])
            self.assertTrue(value['bodyWarning'])
    def test_failed_batch_does_not_advance_sync_cursor(self):
        class Client:
            def sync(self,cursor):return {'cursor':'next','more':False,'items':[('Create','bad-item')]}
            def fetch(self,item):raise RuntimeError('synthetic_failure')
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'state.json').write_text('{"cursor":"old","items":{}}')
            with self.assertRaises(RuntimeError):synchronize(Client(),root,'recruitment','recruit@example.invalid')
            import json
            self.assertEqual(json.loads((root/'state.json').read_text())['cursor'],'old')
    def test_incremental_restart_skips_archived_item(self):
        raw=self.mail()
        class Client:
            count=0
            def sync(self,cursor):return {'cursor':'next','more':False,'items':[('Create','one')]}
            def fetch(self,item):self.count+=1;return raw,'2026-11-05T00:00:00Z'
        with tempfile.TemporaryDirectory() as d:
            c=Client();root=Path(d);synchronize(c,root,'recruitment','recruit@example.invalid');synchronize(c,root,'recruitment','recruit@example.invalid');self.assertEqual(c.count,1)
            import json
            self.assertEqual(json.loads((root/'index.json').read_text())[0]['mailboxId'],'recruitment')

if __name__=='__main__':unittest.main()
