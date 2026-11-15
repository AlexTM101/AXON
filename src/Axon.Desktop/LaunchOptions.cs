namespace Axon.Desktop;
public sealed record LaunchOptions(string? DataDir, string? CodexHome, bool SmokeTest, string? Screenshot) {
 public static LaunchOptions Parse(string[] args) { string? data=null,home=null,shot=null; bool smoke=false; for(int i=0;i<args.Length;i++) { string Value() { if(++i>=args.Length || args[i].StartsWith("--")) throw new ArgumentException("Missing argument"); return args[i]; } switch(args[i]) { case "--data-dir": data=Value(); break; case "--codex-home": home=Value(); break; case "--screenshot": shot=Value(); break; case "--smoke-test": smoke=true; break; default: throw new ArgumentException("Unknown argument"); } } return new(data,home,smoke,shot); }
}
