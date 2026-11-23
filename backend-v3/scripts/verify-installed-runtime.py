"""Run the read-only V4 verifier with its installed, private environment."""
import os,pathlib,re,shutil,stat,subprocess

runtime=pathlib.Path.home()/'Library/Application Support/RecruitWorkbenchV4'
file=runtime/'.env'
info=file.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_mode&0o077 or info.st_uid!=os.getuid():
    raise SystemExit('Expected the owned private installed V4 environment')
env=dict(os.environ)
for line in file.read_text().splitlines():
    match=re.fullmatch(r'(RECRUIT_V4_[A-Z0-9_]+)=(.*)',line)
    if match:env[match[1]]=match[2].strip().strip('\"\'')
source=pathlib.Path(__file__).resolve().parent.parent
node=shutil.which('node')
if not node:raise SystemExit('Node is required')
subprocess.run([node,'--import','tsx',str(source/'scripts/verify-runtime.ts')],cwd=source,env=env,check=True)
