using System.Text.Json;
using System.Text;
using Axon.Core;

// Every assertion drives a public observer behavior against real files; no mock parser.
var tests = new (string Name, Action Body)[]
{
    ("selected history clears skipped empty plan", EmptyHistoryPlan),
    ("selected history recovers disk and isolates noise", SelectedHistory),
    ("old archived lineage nickname and cycle", ArchiveLineage),
    ("interaction cannot reparent root", InteractionRoot),
    ("identity, lineage and index title", Identity),
    ("explicit task lifecycle and unconfirmed freshness", Lifecycle),
    ("call/result pairing and explicit plan fields", CallsAndPlans),
    ("explicit interruption and error", Errors),
    ("unknown messages, malformed rows and privacy", Privacy),
    ("partial UTF-8 and active shared files", PartialWrites),
    ("append is incremental without duplicate events", Append),
    ("truncate resets old state", Truncate),
    ("same-path replacement resets old state", Replace),
    ("missing parent, cycles and 100 agents", Graph),
    ("source states, bounded history and removal", Sources),
    ("actual item shapes with null exit code", ItemShapes),
    ("regular children stay visible", InternalClassification),
    ("index deletion and recreation refreshes titles", IndexRecreation),
    ("in-place rewrite with unchanged tail resets", Rewrite),
    ("unreadable source is recoverable", Unreadable),
    ("provisional child reconciles with own lifecycle", Provisional),
    ("huge private rows preserve metadata and recent events", HugeRows),
    ("path fallback needs a unique parent in same root group", PathFallback),
    ("burst append never seeks past new lifecycle", BurstAppend),
    ("real child keeps explicit parent edge without parent metadata", ParentEdge),
    ("replayed tool pair stays deduplicated after completion", ReplayedCalls),
    ("replayed subagent item stays deduplicated", ReplayedSubagent),
    ("malformed surrogate metadata cannot abort later rows", MalformedMetadata),
    ("malformed surrogate title cannot abort later rows", MalformedTitle),
    ("historical title cache is bounded and keeps active title", BoundedTitles),
    ("unchanged restored index rehydrates titles", RestoredIndex),
    ("unchanged restored home rehydrates titles", RestoredHome),
    ("latest updated_at wins over physical index order", LatestTitle),
    ("explicit guardian source marker is internal", GuardianSource),
    ("replayed completed turn start cannot reopen the task", ReplayedLifecycle),
    ("recent item replay stays deduplicated after FIFO eviction", ItemFifo),
    ("resumed session recovers a previously evicted title", EvictedTitleRecovery),
    ("sustained arrivals cannot starve index recovery or appends", CoalescedRecovery),
};
var failures = 0;
foreach (var test in tests) { try { test.Body(); Console.WriteLine($"PASS {test.Name}"); } catch (Exception e) { failures++; Console.WriteLine($"FAIL {test.Name}: {e.Message}"); } }
Console.WriteLine($"{tests.Length - failures}/{tests.Length} tests passed");
return failures == 0 ? 0 : 1;

static void EmptyHistoryPlan() {
 using var f=new Fixture(); var rows=new List<string>{Meta("root"),Event("plan_update",new {plan=new[]{new {step="stale",status="pending"}}})};
 for(int i=0;i<1300;i++) { if(i==300) rows.Add(Event("plan_update",new {plan=Array.Empty<object>()})); rows.Add(Response("function_call",new {name="exec_command",call_id=$"p{i}",arguments=new string('x',300)})); } f.Write("root",rows.ToArray()); using var o=f.Observer(); var s=o.Scan(Fixture.Now); Check(s.Plans.ContainsKey("root"),"fixture must expose stale prefix"); o.ConfigureSelection("root"); for(int i=0;i<10;i++) s=o.Scan(Fixture.Now); Check(!s.Plans.ContainsKey("root"),"explicit empty plan must clear stale prefix"); Check(!Json(s).Contains(new string('x',100)),"private data excluded");
}
static void SelectedHistory() {
 using var f=new Fixture(); var lines=new List<string>{Meta("root"),Event("plan_update",new {plan=new[]{new {step="Stale prefix plan",status="pending"}}})}; for(int i=0;i<1300;i++) { if(i==300) lines.Add(Event("plan_update",new {plan=new[]{new {step="Earlier plan",status="in_progress"}}})); lines.Add(Response("function_call",new {name="exec_command",call_id=$"r{i}",arguments=new string('x',300)})); } lines.Add(Event("task_complete")); f.Write("root",lines.ToArray()); var noise=new List<string>{Meta("noise")}; for(int i=0;i<800;i++) noise.Add(Response("function_call",new {name="exec_command",call_id=$"n{i}"})); f.Write("noise",noise.ToArray());
 using var o=f.Observer(); o.Scan(Fixture.Now); o.ConfigureSelection("root",false); ObserverSnapshot s=o.Scan(Fixture.Now); Equal("completed",s.Agents.Single(a=>a.Id=="root").State,"partial backfill preserves live state"); for(int i=0;i<10;i++) s=o.Scan(Fixture.Now); Equal(600,s.Events.Count,"selected batch"); Equal("Earlier plan",s.Plans["root"].Single().Step,"backfilled explicit plan"); Equal("completed",s.Agents.Single(a=>a.Id=="root").State,"live state stays authoritative"); Check(s.Events.All(e=>e.AgentId=="root"),"noise excluded"); var ids=s.Events.Select(e=>e.Id).ToHashSet(); o.ConfigureSelection("root",true); for(int i=0;i<10;i++) s=o.Scan(Fixture.Now); Equal(1200,s.Events.Count,"older disk events"); Equal(1200,s.Events.Select(e=>e.Id).Distinct().Count(),"unique events"); Check(ids.All(id=>s.Events.Any(e=>e.Id==id)),"pagination retains batch"); Check(!Json(s).Contains(new string('x',100)),"private payload excluded"); o.ConfigureSelection("noise",false); for(int i=0;i<10;i++) s=o.Scan(Fixture.Now); Check(s.Events.All(e=>e.AgentId=="noise"),"switch excludes old root"); Equal(600,s.Events.Count,"switch resets history limit"); o.ConfigureSelection("root",false); for(int i=0;i<10;i++) s=o.Scan(Fixture.Now); Equal(600,s.Events.Count,"return resets history limit"); Check(s.Events.All(e=>e.AgentId=="root"),"return excludes noise");
}
static void ArchiveLineage() {
 using var f=new Fixture(); f.Write("root",Meta("root")); f.Write("child",Json(new {timestamp=Fixture.Now,type="session_meta",payload=new {id="child",session_id="root",parent_thread_id="root",source=new {subagent=new {thread_spawn=new {agent_path="/root/path",agent_nickname="Real name",parent_thread_id="root"}}}}})); f.Write("grand",Meta("grand","child","/root/path/grand","root"),Event("task_started"));
 Directory.CreateDirectory(Path.Combine(f.Home,"archived_sessions")); File.Move(f.PathFor("root"),Path.Combine(f.Home,"archived_sessions","root.jsonl")); File.SetLastWriteTimeUtc(Path.Combine(f.Home,"archived_sessions","root.jsonl"),Fixture.Now.AddDays(-90).UtcDateTime); File.SetLastWriteTimeUtc(f.PathFor("child"),Fixture.Now.AddDays(-90).UtcDateTime);
 using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal(3,s.Agents.Count,"old archived lineage"); Equal("Real name",s.Agents.Single(a=>a.Id=="child").Name,"nickname"); Equal(2,s.Agents.Single(a=>a.Id=="grand").Depth,"grandchild depth"); File.Move(f.PathFor("grand"),Path.Combine(f.Home,"archived_sessions","grand.jsonl")); s=o.Scan(Fixture.Now); Equal(3,s.Agents.Count,"archive move retains identities"); Equal(1,s.Events.Count(e=>e.AgentId=="grand"),"archive move does not duplicate activity");
 f.Write("a",Meta("a","b")); f.Write("b",Meta("b","a")); s=o.Scan(Fixture.Now); var a=s.Agents.Single(x=>x.Id=="a"); var b=s.Agents.Single(x=>x.Id=="b"); Equal<string?>(null,a.ParentId,"deterministic cycle cut"); Equal("a",b.ParentId,"other cycle edge retained");
}
static void InteractionRoot() { using var f=new Fixture(); f.Write("root",Meta("root")); f.Write("child",Meta("child","root","/root/child"),Event("item_completed",new {item=new {type="SubAgentActivity",kind="interacted",agent_thread_id="root",agent_path="/root"}}),Event("item_completed",new {item=new {type="SubAgentActivity",kind="started",agent_thread_id="root",agent_path="/root"}})); using var o=f.Observer(); var s=o.Scan(Fixture.Now); var root=s.Agents.Single(a=>a.Id=="root"); Equal<string?>(null,root.ParentId,"root parent"); Equal(0,root.Depth,"root depth"); Equal(1,s.Agents.Single(a=>a.Id=="child").Depth,"child depth"); }
static void Identity()
{
    using var f = new Fixture();
    f.Write("root", Meta("root", session: "shared"), Event("task_started"));
    f.Write("child", Meta("child", "root", "/root/research", "shared"), Event("task_started"));
    File.WriteAllText(Path.Combine(f.Home, "session_index.jsonl"), Json(new { id="root", thread_name="Research <safe>", updated_at=Fixture.Now } )+"\n");
    using var o = f.Observer(); var s=o.Scan(Fixture.Now);
    Equal(2,s.Agents.Count,"individual thread identity must not collapse shared session_id");
    Equal("Research <safe>",s.Sessions.Single().Title,"index title");
    var child=s.Agents.Single(a=>a.Id=="child"); Equal("root",child.ParentId,"parent"); Equal("root",child.RootId,"root"); Equal(1,child.Depth,"depth"); Equal("research",child.Name,"humanized path");
    Equal(2,s.Sessions.Single().AgentCount,"root group count");
}
static void Lifecycle()
{
    using var f=new Fixture(); f.Write("root",Meta("root"),Event("task_started"));
    using var o=f.Observer(); var first=o.Scan(Fixture.Now); Equal("started",first.Agents.Single().State,"start"); Equal("recent",first.Agents.Single().Freshness,"recent");
    var stale=o.Scan(Fixture.Now.AddSeconds(45)); Equal("stale",stale.Agents.Single().Freshness,"45s boundary"); Equal("started",stale.Agents.Single().State,"silence must not complete");
    f.Append("root",Event("task_complete",at: Fixture.Now.AddSeconds(46))); Equal("completed",o.Scan(Fixture.Now.AddSeconds(46)).Agents.Single().State,"terminal completion");
}
static void CallsAndPlans()
{
    using var f=new Fixture(); f.Write("root",Meta("root"),Event("task_started"),Response("function_call",new {name="exec_command", @namespace="functions",call_id="c1",arguments="SECRET_ARGUMENT"}));
    using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal("tool",s.Agents.Single().State,"active tool"); Equal(1,s.Agents.Single().ToolCount,"one tool");
    f.Append("root",Response("function_call_output",new {call_id="c1",output="SECRET_OUTPUT"}), Response("function_call",new {name="update_plan",call_id="p1",arguments=Json(new {plan=new[]{new {step="Check inputs",status="in_progress"}}})}));
    s=o.Scan(Fixture.Now); Equal(2,s.Agents.Single().ToolCount,"outputs must not add calls"); Equal("Check inputs",s.Plans["root"].Single().Step,"explicit plan");
    Equal("in_progress",s.Plans["root"].Single().Status,"explicit progress");
    Check(s.Events.Any(e=>e.Tool=="exec_command" && e.Outcome=="completed"),"paired completion");
    Check(!Json(s).Contains("SECRET"),"call arguments/output leaked");
}
static void Errors()
{
    using var f=new Fixture(); f.Write("interrupted",Meta("interrupted"),Event("turn_aborted")); f.Write("error",Meta("error"),Event("error",new{message="SECRET_EXCEPTION"}));
    using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal("interrupted",s.Agents.Single(a=>a.Id=="interrupted").State,"abort"); Equal("error",s.Agents.Single(a=>a.Id=="error").State,"explicit error"); Check(!Json(s).Contains("SECRET"),"error body leaked");
}
static void Privacy()
{
    using var f=new Fixture(); f.Write("root",Meta("root"),Event("task_started"), "{broken}", Response("reasoning",new {summary="SECRET_REASONING",encrypted_content="SECRET_ENCRYPTED"}),Event("future_unknown",new {body="SECRET_BODY"}), Response("message",new {role="user",content="SECRET_PROMPT"}));
    using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal(1,s.Source.MalformedLines,"malformed count"); Equal("started",s.Agents.Single().State,"unknown types do not change state"); Check(!Json(s).Contains("SECRET"),"private fields leaked");
    Check(s.Events.All(e=>e.Kind!="reasoning" && e.Kind!="message"),"private messages exposed");
}
static void PartialWrites()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); var bytes=Encoding.UTF8.GetBytes(Event("plan_update",new {plan=new[]{new {step="Проверка",status="pending"}}})+"\n"); var split=Array.IndexOf(bytes,(byte)0xD0)+1;
    using var stream=new FileStream(f.PathFor("root"),FileMode.Append,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete); stream.Write(bytes,0,split); stream.Flush();
    using var o=f.Observer(); Equal(0,o.Scan(Fixture.Now).Plans.Count,"unfinished line ignored");
    stream.Write(bytes,split,bytes.Length-split); stream.Flush(); var s=o.Scan(Fixture.Now); Equal("Проверка",s.Plans["root"].Single().Step,"split unicode preserved"); Equal(0,s.Source.MalformedLines,"partial UTF8 not malformed");
}
static void Append()
{
    using var f=new Fixture(); f.Write("root",Meta("root"),Event("task_started")); using var o=f.Observer(); var s=o.Scan(Fixture.Now); var count=s.Events.Count; Equal(count,o.Scan(Fixture.Now).Events.Count,"unchanged scan no duplication"); f.Append("root",Event("task_complete")); s=o.Scan(Fixture.Now); Equal(count+1,s.Events.Count,"only appended row"); Equal(s.Events.Count,s.Events.Select(e=>e.Id).Distinct().Count(),"unique event IDs");
}
static void Truncate()
{
    using var f=new Fixture(); f.Write("root",Meta("old"),Event("task_started"),Event("task_complete")); using var o=f.Observer(); o.Scan(Fixture.Now); f.Write("root",Meta("new")); var s=o.Scan(Fixture.Now); Equal("new",s.Agents.Single().Id,"reset identity"); Equal("unknown",s.Agents.Single().State,"reset lifecycle"); Equal(0,s.Events.Count,"no ghost history");
}
static void Replace()
{
    using var f=new Fixture(); f.Write("root",Meta("old"),Event("task_started")); using var o=f.Observer(); o.Scan(Fixture.Now); var temp=Path.Combine(f.Home,"replacement.jsonl"); File.WriteAllText(temp,string.Join("\n",new[]{Meta("new"),Event("task_complete"),Event("task_complete")})+"\n"); File.Move(temp,f.PathFor("root"),true); var s=o.Scan(Fixture.Now); Equal("new",s.Agents.Single().Id,"replacement identity"); Equal("completed",s.Agents.Single().State,"replacement reducer"); Check(s.Events.All(e=>e.AgentId=="new"),"old events removed");
}
static void Graph()
{
    using var f=new Fixture(); f.Write("missing",Meta("missing","absent","/root/missing")); f.Write("a",Meta("a","b")); f.Write("b",Meta("b","a"));
    for(var i=0;i<100;i++)f.Write($"n{i}",Meta($"n{i}",i==0?null:$"n{i-1}",$"/root/n{i}"));
    using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal(103,s.Agents.Count,"large graph"); Equal("absent",s.Agents.Single(a=>a.Id=="missing").RootId,"unobserved parent retained"); Equal("n0",s.Agents.Single(a=>a.Id=="n99").RootId,"deep root"); Equal(99,s.Agents.Single(a=>a.Id=="n99").Depth,"deep depth"); Equal(s.Agents.Single(a=>a.Id=="a").RootId,s.Agents.Single(a=>a.Id=="b").RootId,"cycle deterministic root");
}
static void Sources()
{
    using var f=new Fixture(); using var missing=new CodexObserver(new ObserverOptions(Path.Combine(f.Home,"absent"))); Equal("missing",missing.Scan(Fixture.Now).Source.State,"missing source"); using var o=f.Observer(3); Equal("empty",o.Scan(Fixture.Now).Source.State,"empty source"); f.Write("root",Meta("root"),Event("task_started"),Event("task_complete"),Event("task_started"),Event("task_complete")); var s=o.Scan(Fixture.Now); Equal("connected",s.Source.State,"connected source"); Equal(3,s.Events.Count,"event history bounded"); File.Delete(f.PathFor("root")); s=o.Scan(Fixture.Now); Equal(0,s.Agents.Count,"removed source reconciled");
}
static void ItemShapes()
{
    using var f=new Fixture(); f.Write("root",Meta("root"),Event("task_started"),Event("item_completed",new {item=new {type="CommandExecution",id="command1",status="completed",exit_code=(int?)null,aggregated_output="SECRET_OUTPUT",command="SECRET_COMMAND"}}));
    using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal(1,s.Agents.Single().ToolCount,"item-only command counted"); Equal("exec_command",s.Agents.Single().LastTool,"item-only tool label"); Check(!Json(s).Contains("SECRET"),"command body privacy");
    f.Append("root",Event("item_completed",new {item=new {type="McpToolCall",id="mcp1",server="figma",tool="inspect",status="failed",result="SECRET_RESULT",arguments="SECRET_ARGUMENT"}})); s=o.Scan(Fixture.Now); Equal("error",s.Agents.Single().State,"item failure"); Equal(2,s.Agents.Single().ToolCount,"MCP item counted");
}
static void InternalClassification()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); f.Write("worker",Meta("worker","root","/root/reviewer")); f.Write("internal",Meta("internal","root","/root/internal/guardian")); using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal(false,s.Agents.Single(a=>a.Id=="worker").Internal,"normal workers visible by default"); Equal(true,s.Agents.Single(a=>a.Id=="internal").Internal,"explicit internal segment");
}
static void IndexRecreation()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); var index=Path.Combine(f.Home,"session_index.jsonl"); var line=Json(new{id="root",thread_name="Restored title",updated_at=Fixture.Now})+"\n"; File.WriteAllText(index,line); using var o=f.Observer(); Equal("Restored title",o.Scan(Fixture.Now).Sessions.Single().Title,"initial title"); File.Delete(index); o.Scan(Fixture.Now); File.WriteAllText(index,line); Equal("Restored title",o.Scan(Fixture.Now).Sessions.Single().Title,"recreated identical index");
}
static void Rewrite()
{
    using var f=new Fixture(); f.Write("root",Meta("old"),Event("task_started"),Event("task_complete"),Event("task_started")); using var o=f.Observer(); o.Scan(Fixture.Now); f.Write("root",Meta("new"),Event("task_started"),Event("task_complete"),Event("task_started")); Equal("new",o.Scan(Fixture.Now).Agents.Single().Id,"replaced metadata with equal length and unchanged tail");
}
static void Unreadable()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); using var o=f.Observer(); using(var exclusive=new FileStream(f.PathFor("root"),FileMode.Open,FileAccess.ReadWrite,FileShare.None)) Equal("error",o.Scan(Fixture.Now).Source.State,"locked source reported"); Equal("connected",o.Scan(Fixture.Now).Source.State,"retry recovery");
}
static void Provisional()
{
    using var f=new Fixture(); f.Write("root",Meta("root"),Event("task_started"),Event("item_completed",new {item=new {type="SubAgentActivity",kind="started",agent_thread_id="worker",agent_path="/root/review"}}));
    using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal(2,s.Agents.Count,"provisional child visible"); var child=s.Agents.Single(a=>a.Id=="worker"); Equal("root",child.ParentId,"provisional parent"); Equal("unknown",child.State,"creation is not task start");
    f.Append("root",Event("item_completed",new {item=new {type="SubAgentActivity",kind="completed",agent_thread_id="worker",agent_path="/root/review"}})); Equal("completed",o.Scan(Fixture.Now).Agents.Single(a=>a.Id=="worker").State,"explicit provisional completion");
    f.Write("worker",Meta("worker","root","/root/review"),Event("task_started",at:Fixture.Now.AddSeconds(1))); s=o.Scan(Fixture.Now.AddSeconds(1)); Equal(2,s.Agents.Count,"no duplicate child"); Equal("started",s.Agents.Single(a=>a.Id=="worker").State,"own later turn beats parent completion");
}
static void HugeRows()
{
    using var f=new Fixture(); f.Write("root",Meta("root"),Event("task_started"),Response("function_call_output",new{call_id="absent",output=new string('x',3*1024*1024)}),Event("task_complete")); using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal("root",s.Agents.Single().Id,"metadata kept across tail seek"); Equal("completed",s.Agents.Single().State,"recent terminal state after huge row"); Check(!Json(s).Contains(new string('x',100)),"large raw output discarded"); Equal(0,s.Source.MalformedLines,"intentionally skipped large tail boundary is not malformed");
}
static void PathFallback()
{
    using var f=new Fixture(); f.Write("root",Meta("root",session:"group")); f.Write("other",Meta("other",session:"other-group"));
    f.Write("worker",Json(new {timestamp=Fixture.Now,type="session_meta",payload=new{id="worker",session_id="group",source=new{subagent=new{thread_spawn=new{agent_path="/root/worker",depth=1}}}}}));
    f.Write("deep",Json(new {timestamp=Fixture.Now,type="session_meta",payload=new{id="deep",session_id="group",source=new{subagent=new{thread_spawn=new{agent_path="/root/worker/review",depth=2}}}}}));
    f.Write("orphan",Json(new {timestamp=Fixture.Now,type="session_meta",payload=new{id="orphan",session_id="unknown-group",source=new{subagent=new{thread_spawn=new{agent_path="/root/worker",depth=1}}}}}));
    using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal("root",s.Agents.Single(a=>a.Id=="worker").ParentId,"unique same-group parent"); Equal("worker",s.Agents.Single(a=>a.Id=="deep").ParentId,"exact parent path prefix"); Equal("root",s.Agents.Single(a=>a.Id=="deep").RootId,"nested group lineage"); Equal<string?>(null,s.Agents.Single(a=>a.Id=="orphan").ParentId,"no cross-session path guessing");
}
static void BurstAppend()
{
    using var f=new Fixture(); f.Write("root",Meta("root"),Event("task_started")); using var o=f.Observer(); o.Scan(Fixture.Now);
    f.Append("root",Event("task_complete"),Response("function_call_output",new{call_id="absent",output=new string('x',400*1024)}));
    var s=o.Scan(Fixture.Now); Equal("completed",s.Agents.Single().State,"initial tail seek must not skip completion appended after catch-up");
}
static void ParentEdge()
{
    using var f=new Fixture(); f.Write("root",Meta("root"),Event("item_completed",new {item=new {type="SubAgentActivity",id="spawn1",kind="completed",agent_thread_id="worker",agent_path="/root/review"}}));
    f.Write("worker",Meta("worker"),Event("task_started",at:Fixture.Now.AddSeconds(1))); using var o=f.Observer(); var s=o.Scan(Fixture.Now.AddSeconds(1)); var child=s.Agents.Single(a=>a.Id=="worker"); Equal("root",child.ParentId,"parent's explicit linkage survives sparse child metadata"); Equal("root",child.RootId,"one root group"); Equal("started",child.State,"child still owns lifecycle"); Equal(1,s.Sessions.Count,"child not split into a new session");
}
static void ReplayedCalls()
{
    using var f=new Fixture(); var call=Response("function_call",new{name="exec_command",call_id="stable-call",arguments="SECRET"}); var output=Response("function_call_output",new{call_id="stable-call",output="SECRET"}); f.Write("root",Meta("root"),call,output); using var o=f.Observer(); var before=o.Scan(Fixture.Now); f.Append("root",call,output); var after=o.Scan(Fixture.Now); Equal(1,after.Agents.Single().ToolCount,"completed call ID remains deduplicated"); Equal(before.Events.Count,after.Events.Count,"replayed pair adds no events");
}
static void ReplayedSubagent()
{
    using var f=new Fixture(); var activity=Event("item_completed",new {item=new {type="SubAgentActivity",id="stable-item",kind="started",agent_thread_id="worker",agent_path="/root/review"}}); f.Write("root",Meta("root"),activity); using var o=f.Observer(); var before=o.Scan(Fixture.Now); f.Append("root",activity); Equal(before.Events.Count,o.Scan(Fixture.Now).Events.Count,"subagent item ID deduplicates before projection");
}
static void MalformedMetadata()
{
    using var f=new Fixture(); var malformed=Meta("root").Replace("root","\\uD800",StringComparison.Ordinal); f.Write("root",malformed,Meta("root"),Event("task_complete")); using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal("completed",s.Agents.Single().State,"valid rows following malformed escaped surrogate still reduce"); Equal(1,s.Source.MalformedLines,"malformed metadata row counted once");
}
static void MalformedTitle()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); File.WriteAllText(Path.Combine(f.Home,"session_index.jsonl"),"{\"id\":\"bad\",\"thread_name\":\"\\uD800\"}\n"+Json(new{id="root",thread_name="Valid title",updated_at=Fixture.Now})+"\n"); using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal("Valid title",s.Sessions.Single().Title,"valid index rows survive a malformed surrogate"); Equal(1,s.Source.MalformedLines,"malformed index row counted once");
}
static void BoundedTitles()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); var index=Path.Combine(f.Home,"session_index.jsonl"); using(var writer=new StreamWriter(index)) {writer.WriteLine(Json(new{id="root",thread_name="Keep active title",updated_at=Fixture.Now.AddYears(-1)})); for(var i=0;i<6000;i++)writer.WriteLine(Json(new{id=$"old-{i}",thread_name=$"Historical {i}",updated_at=Fixture.Now.AddSeconds(i)}));}
    using var o=f.Observer(); ObserverSnapshot s=o.Scan(Fixture.Now); for(var i=0;i<5;i++)s=o.Scan(Fixture.Now); Equal("Keep active title",s.Sessions.Single().Title,"active title survives newer unrelated history");
    // This asserts the resource ceiling, not source text or a private algorithm.
    var cache=(System.Collections.IDictionary)typeof(CodexObserver).GetField("titles",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance)!.GetValue(o)!;
    Check(cache.Count<=4097,$"title retention must be bounded to historical cache plus active IDs; got {cache.Count}");
}
static void RestoredIndex()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); var index=Path.Combine(f.Home,"session_index.jsonl"); var hidden=Path.Combine(f.Home,"index-hidden"); File.WriteAllText(index,Json(new{id="root",thread_name="Restored unchanged",updated_at=Fixture.Now})+"\n"); using var o=f.Observer(); o.Scan(Fixture.Now); File.Move(index,hidden); o.Scan(Fixture.Now); File.Move(hidden,index); Equal("Restored unchanged",o.Scan(Fixture.Now).Sessions.Single().Title,"same unchanged file must be reread after absence");
}
static void RestoredHome()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); File.WriteAllText(Path.Combine(f.Home,"session_index.jsonl"),Json(new{id="root",thread_name="Restored home",updated_at=Fixture.Now})+"\n"); using var o=f.Observer(); o.Scan(Fixture.Now); var moved=f.Home+"-hidden"; Directory.Move(f.Home,moved); try {Equal("missing",o.Scan(Fixture.Now).Source.State,"temporary source absence");} finally {Directory.Move(moved,f.Home);} Equal("Restored home",o.Scan(Fixture.Now).Sessions.Single().Title,"restored directory's same index must be reread");
}
static void LatestTitle()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); var index=Path.Combine(f.Home,"session_index.jsonl"); File.WriteAllText(index,Json(new{id="root",thread_name="Newer title",updated_at=Fixture.Now})+"\n"+Json(new{id="root",thread_name="Older title",updated_at=Fixture.Now.AddDays(-1)})+"\n"); using var o=f.Observer(); Equal("Newer title",o.Scan(Fixture.Now).Sessions.Single().Title,"latest update timestamp wins");
}
static void GuardianSource()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); f.Write("guardian",Json(new {timestamp=Fixture.Now,type="session_meta",payload=new{id="guardian",session_id="root",parent_thread_id="root",agent_path=(string?)null,agent_role=(string?)null,source=new{subagent=new{other="guardian"}}}})); f.Write("ordinary",Meta("ordinary","root","/root/reviewer")); using var o=f.Observer(); var s=o.Scan(Fixture.Now); Equal(true,s.Agents.Single(a=>a.Id=="guardian").Internal,"explicit guardian source marker"); Equal(false,s.Agents.Single(a=>a.Id=="ordinary").Internal,"ordinary reviewer remains visible");
}
static void ReplayedLifecycle()
{
    using var f=new Fixture(); var start=Event("task_started",new{turn_id="turn-1"}); var complete=Event("task_complete",new{turn_id="turn-1"}); f.Write("root",Meta("root"),start,complete); using var o=f.Observer(); var before=o.Scan(Fixture.Now); f.Append("root",start); var after=o.Scan(Fixture.Now); Equal("completed",after.Agents.Single().State,"duplicate start cannot reopen its completed turn"); Equal(before.Events.Count,after.Events.Count,"lifecycle replay adds no activity");
    f.Append("root",Event("task_started",new{turn_id="turn-2"})); Equal("started",o.Scan(Fixture.Now).Agents.Single().State,"a genuinely new turn still starts"); f.Append("root",complete); Equal("started",o.Scan(Fixture.Now).Agents.Single().State,"duplicate completion of prior turn cannot close the new one");
}
static void ItemFifo()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); using var o=f.Observer(5000); o.Scan(Fixture.Now); string latest="";
    for(var batch=0;batch<33;batch++)
    {
        var lines=new List<string>(); for(var i=batch*128;i<Math.Min((batch+1)*128,4098);i++) {latest=Event("item_completed",new{item=new{type="SubAgentActivity",id=$"item-{i}",kind="interacted",agent_thread_id="worker",agent_path="/root/worker"}}); lines.Add(latest);} if(lines.Count>0){f.Append("root",lines.ToArray()); o.Scan(Fixture.Now);}
    }
    var before=o.Scan(Fixture.Now); Equal(4098,before.Events.Count,"all distinct item IDs observed incrementally"); f.Append("root",latest); Equal(before.Events.Count,o.Scan(Fixture.Now).Events.Count,"recent item must survive FIFO eviction and remain deduplicated");
}
static void EvictedTitleRecovery()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); var index=Path.Combine(f.Home,"session_index.jsonl"); using(var writer=new StreamWriter(index)){writer.WriteLine(Json(new{id="resumed",thread_name="Recovered session title",updated_at=Fixture.Now.AddDays(-30)})); for(var i=0;i<6000;i++)writer.WriteLine(Json(new{id=$"history-{i}",thread_name=$"History {i}",updated_at=Fixture.Now.AddSeconds(i)}));}
    using var o=f.Observer(); for(var i=0;i<6;i++)o.Scan(Fixture.Now);
    var cache=(System.Collections.IDictionary)typeof(CodexObserver).GetField("titles",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance)!.GetValue(o)!; Check(!cache.Contains("resumed"),"inactive old title must actually be evicted before exercising recovery");
    f.Write("resumed",Meta("resumed"),Event("task_started")); var snapshot=o.Scan(Fixture.Now); for(var i=0;i<6;i++)snapshot=o.Scan(Fixture.Now); Equal("Recovered session title",snapshot.Sessions.Single(s=>s.Id=="resumed").Title,"resuming a rollout must recover its old index title without another rename"); Check(cache.Count<=4098,"title recovery preserves historical-plus-active cache bound");
}
static void CoalescedRecovery()
{
    using var f=new Fixture(); f.Write("root",Meta("root")); f.Write("tail",Meta("tail")); f.Write("resumed",Meta("resumed")); File.SetLastWriteTimeUtc(f.PathFor("resumed"),Fixture.Now.AddDays(-40).UtcDateTime);
    var index=Path.Combine(f.Home,"session_index.jsonl"); var padding=new string('p',1024); var inserted=false;
    using(var writer=new StreamWriter(index,false,new UTF8Encoding(false)))
    {
        while(writer.BaseStream.Position<8*1024*1024)
        {
            writer.WriteLine(Json(new{id="filler",thread_name="Padding record",updated_at=Fixture.Now,padding}));
            if(!inserted && writer.BaseStream.Position>7*1024*1024){writer.WriteLine(Json(new{id="resumed",thread_name="Recovered late title",updated_at=Fixture.Now.AddDays(-30)})); inserted=true;}
        }
    }
    Check(new FileInfo(index).Length>=8*1024*1024,"fixture must exceed sixteen512KiB index reads"); using var o=f.Observer(); o.Scan(Fixture.Now); File.AppendAllText(index,Json(new{id="tail",thread_name="New appended title",updated_at=Fixture.Now})+"\n");
    var recovered=false; var appended=false; ObserverSnapshot snapshot=o.Scan(Fixture.Now);
    for(var tick=1;tick<=50;tick++)
    {
        if(tick==10)f.Append("resumed",Event("task_started"));
        if(tick%10==0)f.Write($"arrival-{tick}",Meta($"arrival-{tick}"));
        snapshot=o.Scan(Fixture.Now); recovered|=snapshot.Sessions.Any(session=>session.Id=="resumed" && session.Title=="Recovered late title"); appended|=snapshot.Sessions.Any(session=>session.Id=="tail" && session.Title=="New appended title");
    }
    Check(recovered && appended,$"sustained arrivals must allow both full-pass recovery and append progress; recovered={recovered}, appended={appended}");
    var cache=(System.Collections.IDictionary)typeof(CodexObserver).GetField("titles",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance)!.GetValue(o)!; Check(cache.Count<=4096+snapshot.Agents.Count,"coalescing preserves bounded title retention");
}
static string Meta(string id,string? parent=null,string? path=null,string? session=null)=>Json(new {timestamp=Fixture.Now,type="session_meta",payload=new {id,session_id=session??id,parent_thread_id=parent,source=parent==null?(object)"cli":new {subagent=new {thread_spawn=new {depth=1,agent_path=path??"/root/worker",agent_nickname="",parent_thread_id=parent}}},base_instructions="SECRET_INSTRUCTIONS",creator_account_id="SECRET_ACCOUNT"}});
static string Event(string type,object? fields=null,DateTimeOffset? at=null)=>Envelope("event_msg",type,fields,at);
static string Response(string type,object fields)=>Envelope("response_item",type,fields,null);
static string Envelope(string category,string type,object? fields,DateTimeOffset? at){var payload=fields==null?new Dictionary<string,object?>():JsonSerializer.Deserialize<Dictionary<string,object?>>(Json(fields))!; payload["type"]=type; return Json(new{timestamp=at??Fixture.Now,type=category,payload});}
static string Json(object obj)=>JsonSerializer.Serialize(obj,new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase});
static void Check(bool ok,string message){if(!ok)throw new Exception(message);}
static void Equal<T>(T expected,T actual,string message){if(!EqualityComparer<T>.Default.Equals(expected,actual))throw new Exception($"{message}: expected {expected}, got {actual}");}
sealed class Fixture:IDisposable
{
    public static readonly DateTimeOffset Now=DateTimeOffset.UtcNow;
    public string Home {get;}=Path.Combine(Path.GetTempPath(),"axon-tests-"+Guid.NewGuid().ToString("N"));
    public Fixture()=>Directory.CreateDirectory(Path.Combine(Home,"sessions"));
    public string PathFor(string id)=>Path.Combine(Home,"sessions",id+".jsonl");
    public void Write(string id,params string[] lines)=>File.WriteAllText(PathFor(id),string.Join("\n",lines)+"\n",new UTF8Encoding(false));
    public void Append(string id,params string[] lines)=>File.AppendAllText(PathFor(id),string.Join("\n",lines)+"\n",new UTF8Encoding(false));
    public CodexObserver Observer(int max=600)=>new(new ObserverOptions(Home,14,max));
    public void Dispose()=>Directory.Delete(Home,true);
}



















