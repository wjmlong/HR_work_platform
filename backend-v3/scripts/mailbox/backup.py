"""Back up immutable mail directories; omit cursors so restores reconcile with EWS."""
import argparse
import datetime
import io
import json
import os
import re
import tarfile
import tempfile
from pathlib import Path


def backup(source, destination):
    source, destination = Path(source), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix='.mail-backup-', dir=str(destination.parent))
    os.close(fd)
    count = 0
    try:
        with tarfile.open(temp, 'w:gz') as archive:
            for account in source.iterdir():
                if not account.is_dir() or account.is_symlink() or not re.match(r'^[a-z][a-z0-9_-]{0,63}$', account.name):
                    continue
                index = []
                for message in (account / 'messages').iterdir():
                    if not re.match(r'^[a-f0-9]{64}$', message.name) or message.is_symlink():
                        continue
                    metadata = json.loads((message / 'message.json').read_text(encoding='utf-8'))
                    archive.add(str(message), arcname=account.name + '/messages/' + message.name)
                    index.append({key: metadata[key] for key in ('id','mailboxId','subject','senderName','senderEmail','receivedAt','attachments')})
                    count += 1
                content = json.dumps(index, ensure_ascii=False).encode('utf-8')
                info = tarfile.TarInfo(account.name + '/index.json')
                info.size, info.mode = len(content), 0o600
                archive.addfile(info, io.BytesIO(content))
        os.replace(temp, str(destination))
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return count


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    day = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d')
    count = backup(args.source, Path(args.destination) / ('mailbox-' + day + '.tar.gz'))
    print(json.dumps({'event': 'mailbox_backup_complete', 'messages': count}))
