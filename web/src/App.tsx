import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  Briefcase,
  ArrowRight,
  CheckCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { initialPage, navigation, peopleLanding } from "./lib/prd";
import { api, setCsrf } from "./lib/api";
import { Context, useResource, type Row, type User } from "./lib/state";
const Upload = lazy(() => import("./features/Upload")),
  CandidateCollection = lazy(() => import("./features/CandidateCollection")),
  Mailbox = lazy(() => import("./features/Mailbox")),
  ReportDashboard = lazy(() => import("./features/ReportDashboard")),
  InterviewerReview = lazy(() => import("./features/InterviewerReview")),
  People = lazy(() => import("./features/People")),
  Jobs = lazy(() => import("./features/Jobs")),
  Interviews = lazy(() => import("./features/Interviews")),
  Materials = lazy(() => import("./features/Materials")),
  Statistics = lazy(() => import("./features/Statistics")),
  RecruitingToolkit = lazy(() => import("./features/RecruitingToolkit")),
  Sourcing = lazy(() => import("./features/Sourcing")),
  Admin = lazy(() => import("./features/Admin")),
  ApplicationDetail = lazy(() => import("./features/ApplicationDetail")),
  Person = lazy(() => import("./features/Person"));
const MyInterviews = lazy(() => import("./features/MyInterviews"));
const Backups = lazy(() => import("./features/Backups"));
const nav = navigation;
class Boundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="login">
        <h1>页面暂时无法显示</h1>
        <p>请刷新页面。已提交数据仍保存在服务器。</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [page, setPage] = useState(location.hash.slice(1) || "overview"),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [application, setApplication] = useState(""),
    [editApplication,setEditApplication]=useState(false),
    [person, setPerson] = useState(""),
    [backup, setBackup] = useState<"export" | "import" | null>(null);
  async function identity() {
    setLoading(true);
    try {
      const me = await api<User>("/auth/me");
      setUser(me);
      setCsrf(me.csrf);
      setError("");
    } catch (e) {
      setUser(null);
      setCsrf("");
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void identity();
    const expired = () => {
      setUser(null);
      setCsrf("");
      setApplication("");
      setPerson("");
    };
    window.addEventListener("session-expired", expired);
    const hash = () => {
      if (/^#mailbox(?:\?|$)/.test(location.hash)) {
        window.history.replaceState(window.history.state, "", location.hash.replace(/^#mailbox/, "#inbox/mailbox"));
      }
      setPage(location.hash.slice(1) || "overview");
    };
    hash();
    window.addEventListener("hashchange", hash);
    return () => {
      window.removeEventListener("session-expired", expired);
      window.removeEventListener("hashchange", hash);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timeout);
  }, [toast]);
  const canWrite = !!user?.roles.some((r) =>
      ["admin", "manager", "recruiter"].includes(r),
    ),
    canManage = !!user?.roles.some((r) => ["admin", "manager"].includes(r)),
    isAdmin = !!user?.roles.includes("admin"),
    interviewer = !!user?.roles.includes("interviewer");
  const jobs = useResource<Row[]>(
    (s) =>
      user?.status === "active" && (!user.temporaryAccess || user.roles.some(r=>["admin","manager","recruiter","interviewer"].includes(r)))
        ? api("/jobs", { signal: s })
        : Promise.resolve([]),
    [user?.id, canWrite, revision],
  );
  const notify = (text: string, error = false) => setToast({ text, error }),
    refresh = () => setRevision((v) => v + 1);
  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
      setUser(null);
      setCsrf("");
      setApplication("");
      setPerson("");
      setError("");
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  if (loading)
    return (
      <main className="login" role="status">
        正在核对企业身份…
      </main>
    );
  if (!user)
    return (
      <main className="login">
        <span className="brand-icon">
          <Briefcase size={28} />
        </span>
        <p className="login-eyebrow">人力资源部 · 招聘与人才</p>
        <h1>让合适的人，<br />在这里相遇。</h1>
        <p>招聘工作台 · 从岗位需求到面试与录用</p>
        <a className="button primary" href="/api/v4/auth/feishu/start">
          使用企业飞书登录
          <ArrowRight size={18} />
        </a>
        {error && !error.includes("请先") && <p className="muted">{error}</p>}
        <p className="muted">已获面试授权仍须登录；若飞书提示无应用权限，请联系管理员检查“招聘”应用可用范围。</p>
        <p className="login-foot">招聘工作台与人才搜集 · 规则辅助，人工判断</p>
      </main>
    );
  if (user.status !== "active" && !user.temporaryAccess)
    return (
      <main className="login">
        <h1>正在等待管理员审批</h1>
        <p>{user.name}，企业飞书身份已验证。管理员批准并分配角色后可进入。</p>
        <div className="toolbar">
          <button className="primary" onClick={() => void identity()}>
            刷新审批状态
          </button>
          <button onClick={() => void logout()}>退出账号</button>
        </div>
      </main>
    );
  const temporaryOnly = !!user.temporaryAccess && (user.status!=="active" || !user.roles.some(r=>["admin","manager","recruiter","interviewer"].includes(r)));
  const screeningOnly = !canWrite && !temporaryOnly && !!user.screeningScope?.length;
  const canSource = !temporaryOnly && !screeningOnly;
  const allowed = temporaryOnly ? [["my-interviews","我的面试"] as const] : canWrite
    ? nav
    : nav.filter(([id]) =>
        (screeningOnly
          ? ["toolkit", ...(interviewer ? ["interviews"] : [])]
          : [
              "board",
              "people",
              "briefs",
              ...(interviewer ? ["questions", "evaluations", "interviews"] : []),
            ]
        ).includes(id),
      );
  const route = initialPage(page);
  const effective =
    temporaryOnly ? "my-interviews" : route === "mailbox" && canWrite ? "mailbox" : route === "my-interviews" && user.temporaryAccess ? "my-interviews" : route === "sourcing" && canSource
      ? "sourcing"
      : route === "admin" && canManage
        ? "admin"
        : allowed.some(([id]) => id === route)
          ? route
          : screeningOnly ? "toolkit" : "board";
  function content() {
    switch (effective) {
      case "my-interviews": return <MyInterviews/>;
      case "inbox":
        return <CandidateCollection key="inbox" lifecycle="inbox" />;
      case "mailbox":
        return <Mailbox jobs={jobs.data || []} />;
      case "upload":
        return <Upload jobs={jobs.data || []} />;
      case "overview":
        return <ReportDashboard jobs={jobs.data || []} />;
      case "board":
        return canWrite ? (
          <RecruitingToolkit key="board" jobs={jobs.data || []} initialTab="board" />
        ) : (
          <People jobs={jobs.data || []} board />
        );
      case "people":
        return canWrite && peopleLanding(page) === "archive" ? <CandidateCollection key="archive" lifecycle="archive" /> : <People key={page} jobs={jobs.data || []} />;
      case "jobs":
        return <Jobs jobs={jobs.data || []} />;
      case "questions":
        return <Materials key="questions" />;
      case "briefs":
        return <Materials key="briefs" brief />;
      case "interviews":
        return <Interviews key="schedule" />;
      case "evaluations":
        return <Interviews key="schedule-mine" initialMine />;
      case "interviewer-review":
        return <InterviewerReview />;
      case "statistics":
        return <Statistics />;
      case "toolkit":
        return <RecruitingToolkit key="toolkit" jobs={jobs.data || []} />;
      case "sourcing":
        return <Sourcing jobs={jobs.data || []} />;
      case "admin":
        return <Admin />;
      default:
        return null;
    }
  }
  return (
    <Boundary>
      <Context.Provider
        value={{
          user,
          revision,
          refresh,
          notify,
          canWrite,
          canManage,
          isAdmin,
          openApplication: (id,edit=false) => {
            setEditApplication(edit);
            setPerson("");
            setApplication(id);
          },
          openPerson: (id) => {
            setApplication("");
            setPerson(id);
          },
        }}
      >
        <WorkspaceShell
          navigation={temporaryOnly ? allowed : [...allowed, ...(user.temporaryAccess ? [["my-interviews","我的面试"] as const] : []), ...(canSource ? [["sourcing", "人才搜集"] as const] : []), ...(canManage ? [["admin", "管理设置"] as const] : [])]}
          active={effective}
          name={user.name}
          isAdmin={isAdmin}
          onBackup={setBackup}
          onLogout={() => void logout()}
        >
        {user.environment === "isolated_test" && (
          <div className="test-environment">
            独立验收环境 · 仅含合成数据，操作不会影响业务库
          </div>
        )}
        <main
          id="workspace-content"
          tabIndex={-1}
          className={
            "main-content " +
            (effective === "sourcing" ? "sourcing-content" : effective === "mailbox" ? "mailbox-content" : "")
          }
        >
          {jobs.error && canWrite && (
            <p className="notice error" role="alert">
              {jobs.error}
              <button onClick={jobs.reload}>重试加载岗位</button>
            </p>
          )}
          <Suspense fallback={<div className="loading">正在打开页面…</div>}>
            {content()}
          </Suspense>
        </main>
        </WorkspaceShell>
        {toast && (
          <div
            role={toast.error ? "alert" : "status"}
            className={"toast " + (toast.error ? "error" : "")}
          >
            {toast.error ? (
              <WarningCircle size={21} />
            ) : (
              <CheckCircle size={21} />
            )}
            <span>{toast.text}</span>
            <button onClick={() => setToast(null)} aria-label="关闭提示">
              关闭
            </button>
          </div>
        )}
        <Suspense fallback={null}>
          {backup && <Backups mode={backup} onClose={() => setBackup(null)} />}
          {application && (
            <ApplicationDetail
              key={application+String(editApplication)}
              initialEdit={editApplication}
              id={application}
              jobs={jobs.data || []}
              onClose={() => setApplication("")}
            />
          )}{" "}
          {person && (
            <Person
              id={person}
              jobs={jobs.data || []}
              onClose={() => setPerson("")}
            />
          )}
        </Suspense>
      </Context.Provider>
    </Boundary>
  );
}
