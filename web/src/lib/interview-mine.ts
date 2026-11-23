// 待我评估：只看本人参与、且还能打分的面试。
// 主责面试官和普通面试官都算「我」；已取消、已移入回收安排的场次不出现。
// 这只是把当前页已有的面试安排按参与人过滤，不改变服务端查询范围，也不代表评估已完成。
export type InterviewRow = {
  status?: string;
  primary_interviewer_id?: string | null;
  interviewer_ids?: string[] | null;
};

export function isMyEvaluation(interview: InterviewRow, userId: string, deleted = false) {
  if (!userId || deleted) return false;
  if (interview.status === "cancelled") return false;
  return (
    interview.primary_interviewer_id === userId ||
    !!interview.interviewer_ids?.includes(userId)
  );
}

export function pendingEvaluations<T extends InterviewRow>(
  interviews: T[],
  userId: string,
  deleted = false,
) {
  return interviews.filter((interview) => isMyEvaluation(interview, userId, deleted));
}
