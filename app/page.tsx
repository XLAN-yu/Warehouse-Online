export default function Home() {
  return (
    <main className="workbench" aria-label="信号分析工具">
      <iframe
        className="visualization-frame"
        src="/signal-tool-layout.html"
        title="信号分析工具"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    </main>
  );
}
