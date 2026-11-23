export class LauncherSession {
  constructor({ publishStatus, publishConnections, publishLog, refreshHardware, retireRequests }) {
    Object.assign(this, { publishStatus, publishConnections, publishLog, refreshHardware, retireRequests });
    this.status = {};
    this.revision = 0;
    this.source = null;
    this.timer = null;
    this.onVisible = () => { if (!document.hidden) this.refreshHardware(); };
  }
  publish(status) {
    this.observe(status);
    this.publishStatus(this.status);
  }
  observe(status) {
    this.revision++;
    this.status = status || {};
  }
  applyResponse(status, revision) {
    if (this.revision === revision && (status.phase || "check_ok" in status)) this.publish(status);
  }
  start() {
    if (this.source) return;
    this.source = new EventSource("/api/events");
    this.source.onmessage = event => {
      let data;
      try { data = JSON.parse(event.data); } catch (_) { return; }
      if (data.type === "log") this.publishLog(data.line);
      else if (data.type === "status") this.publish(data);
      else if (data.type === "connections") {
        this.observe({ ...this.status, connections: data.connections });
        this.publishConnections(this.status);
      }
    };
    const initialRevision = this.revision;
    const source = this.source;
    void fetch("/api/status").then(response => response.json()).then(status => {
      if (this.source === source && this.revision === initialRevision) this.publish(status);
    }).catch(() => {});
    this.timer = setInterval(() => this.refreshHardware(), 5000);
    document.addEventListener("visibilitychange", this.onVisible);
  }
  stop() {
    this.source?.close?.();
    this.source = null;
    clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.retireRequests();
  }
}
