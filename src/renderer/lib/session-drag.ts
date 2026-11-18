const sessionType = 'application/x-gravity-session';
export function startSessionDrag(data: DataTransfer, sessionId: string) {
  data.setData(sessionType, sessionId);
  data.effectAllowed = 'move';
}
export function isSessionDrag(data: DataTransfer) { return Array.from(data.types).includes(sessionType); }
export function droppedSession(data: DataTransfer) { return data.getData(sessionType); }
