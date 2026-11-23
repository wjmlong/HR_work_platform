import { useEffect, useState, type ReactNode } from 'react';
import { Briefcase, SquaresFour, UsersThree, UploadSimple, EnvelopeSimple, CalendarBlank, ChatsCircle, ClipboardText, ChartBar, BookOpen, Compass, Gear, SignOut, UserCircle, List, X, ArrowDown, ArrowUp, CaretRight } from '@phosphor-icons/react';

const icons = { overview: ChartBar, board: SquaresFour, jobs: Briefcase, people: UsersThree, upload: UploadSimple, mailbox: EnvelopeSimple, inbox: EnvelopeSimple, interviews: CalendarBlank, 'my-interviews': CalendarBlank, questions: BookOpen, evaluations: ClipboardText, 'interviewer-review': ChatsCircle, briefs: Compass, statistics: ChartBar, toolkit: List, sourcing: UsersThree, admin: Gear };
const groups = [
  { title: 'AI 招聘工作台', ids: ['overview', 'jobs', 'sourcing', 'inbox', 'upload', 'toolkit'] },
  { title: '面试协作', ids: ['my-interviews', 'interviews', 'questions', 'interviewer-review', 'briefs'] },
  { title: '工作台管理', ids: ['people', 'statistics', 'admin'] },
];

export function WorkspaceShell({ children, navigation, active, name, isAdmin, onBackup, onLogout }: {
  children: ReactNode; navigation: readonly (readonly [string, string])[]; active: string; name: string; isAdmin: boolean;
  onBackup: (mode: 'export' | 'import') => void; onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }, [active]);
  const resolved = active === 'board' ? 'toolkit' : active === 'mailbox' ? 'inbox' : active === 'evaluations' ? 'interviews' : active;
  const current = active === 'mailbox' ? '原始来信' : navigation.find(([id]) => id === resolved)?.[1] || '招聘工作台';
  return <div className="workspace-shell">
    <a className="skip-content" href="#workspace-content" onClick={(event) => { event.preventDefault(); document.getElementById('workspace-content')?.focus(); }}>跳至页面内容</a>
    <aside className="workspace-sidebar" data-open={open} aria-label="招聘工作台导航">
      <a className="workspace-brand" href="#overview" onClick={() => setOpen(false)}>
        <span className="workspace-mark"><Briefcase size={25} weight="light" /></span>
        <span><small>人力资源部</small><strong>招聘工作台</strong></span>
      </a>
      <nav aria-label="主要导航" className="workspace-navigation">
        {groups.map(group => {
          const links = group.ids.flatMap(id => navigation.filter(([key]) => key === id));
          return links.length ? <div className="workspace-nav-group" key={group.title}>
            <p>{group.title}</p>
            {links.map(([id, title]) => { const Icon = icons[id as keyof typeof icons] || Briefcase; const on = resolved === id; return <a key={id} href={'#' + id} aria-current={on ? 'page' : undefined} className={on ? 'active' : ''} onClick={() => setOpen(false)}><Icon size={20} weight={on ? 'regular' : 'light'} /><span>{title}</span>{on && <CaretRight size={13} />}</a>; })}
          </div> : null;
        })}
      </nav>
      <div className="workspace-sidebar-bottom">
        {isAdmin && <div className="workspace-backups"><button onClick={() => onBackup('export')}><ArrowDown size={16} />导出备份</button><button onClick={() => onBackup('import')}><ArrowUp size={16} />导入备份</button></div>}
        <div className="workspace-account"><UserCircle size={28} weight="light" /><span><strong>{name}</strong><small>飞书企业账号</small></span><button className="icon-button" onClick={onLogout} aria-label="退出登录" title="退出登录"><SignOut size={19} /></button></div>
      </div>
    </aside>
    <div className="workspace-body">
      <header className="workspace-topline">
        <button className="workspace-menu icon-button" onClick={() => setOpen(!open)} aria-label={open ? '收起导航' : '展开导航'} aria-expanded={open}>{open ? <X size={21} /> : <List size={21} />}</button>
        {active === 'mailbox' ? <nav className="workspace-breadcrumb" aria-label="面包屑"><a href="#inbox">简历收件箱</a><CaretRight size={13} /><strong aria-current="page">原始来信</strong></nav> : <div className="workspace-breadcrumb"><span>人力资源部</span><CaretRight size={13} /><strong>招聘与人才</strong></div>}
        <span className="workspace-current">{current}</span>
      </header>
      {children}
    </div>
  </div>;
}
