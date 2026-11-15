using Axon.Desktop;
var dir = Path.Combine(Path.GetTempPath(), "axon-test-" + Guid.NewGuid()); Directory.CreateDirectory(dir);
try {
 if (!WebViewInstall.IsAllowed("https://developer.microsoft.com/en-us/microsoft-edge/webview2/") || WebViewInstall.IsAllowed("https://example.com/")) throw new Exception("installation destination allowlist");
 var requests=new HistoryRequests(); requests.BeginGeneration(1,"A");
 // The worker has not claimed yet: the selection and its request must be claimed together.
 requests.Select("B"); requests.LoadOlder(); var claim=requests.Claim(1);
 if(claim is null || claim.RootId!="B" || claim.OlderCount!=1) throw new Exception("selection and older request split");
 using var waiting=new ManualResetEventSlim(); using var release=new ManualResetEventSlim(); var staleWorker=Task.Run(()=>{waiting.Set(); release.Wait(); return requests.Claim(1);}); waiting.Wait(); requests.BeginGeneration(2,"C"); requests.LoadOlder(); release.Set(); if(await staleWorker is not null) throw new Exception("stale generation consumed request");
 claim=requests.Claim(2); if(claim is null || claim.RootId!="C" || claim.OlderCount!=1) throw new Exception("new generation request lost");
 requests.Select("D"); requests.LoadOlder(); requests.Select("E"); claim=requests.Claim(2); if(claim is null || claim.RootId!="E" || claim.OlderCount!=0) throw new Exception("old selection request leaked");
 var store = new SettingsStore(dir, true);
 if (!store.Load().ReducedMotion) throw new Exception("OS motion default lost");
 store.Save(new Settings { View="list", ReducedMotion=false, CollapsedIds=["one"], SelectedSessionId="abc" });
 var s=store.Load(); if(s.View!="list" || s.ReducedMotion || s.SelectedSessionId!="abc" || s.CollapsedIds[0]!="one") throw new Exception("settings roundtrip");
 File.WriteAllText(Path.Combine(dir,"settings.json"), "{\"sidebarCollapsed\":true,\"inspectorCollapsed\":true,\"selectedSessionId\":\"pinned\",\"view\":\"list\",\"followLatest\":false,\"collapsedIds\":[\"branch\"]}");
 store.Save(store.Load());
 using(var layoutJson=System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(dir,"settings.json")))) {
   var layout=layoutJson.RootElement;
   if(!layout.TryGetProperty("sidebarCollapsed",out var side) || !side.GetBoolean() || !layout.TryGetProperty("inspectorCollapsed",out var inspector) || !inspector.GetBoolean()) throw new Exception("independent layout preferences lost on settings roundtrip");
   if(layout.GetProperty("selectedSessionId").GetString()!="pinned" || layout.GetProperty("view").GetString()!="list" || layout.GetProperty("collapsedIds")[0].GetString()!="branch") throw new Exception("layout roundtrip lost existing preferences");
  if(!layout.GetProperty("activityCollapsed").GetBoolean() || layout.GetProperty("uiLayoutVersion").GetInt32()!=2) throw new Exception("scene-first migration missing bottom dock/version");
 }
 foreach(var layout in new[]{(sidebar:true,inspector:false),(sidebar:false,inspector:true)}) {
   var layoutSettings=store.Load(); layoutSettings.SidebarCollapsed=layout.sidebar; layoutSettings.InspectorCollapsed=layout.inspector; store.Save(layoutSettings);
   var loadedLayout=store.Load(); if(loadedLayout.SidebarCollapsed!=layout.sidebar || loadedLayout.InspectorCollapsed!=layout.inspector) throw new Exception("layout preferences are coupled");
 }
 File.WriteAllText(Path.Combine(dir,"settings.json"), "{}");
 if(!store.Load().SidebarCollapsed || !store.Load().InspectorCollapsed) throw new Exception("scene-first legacy migration did not collapse panels");
 File.WriteAllText(Path.Combine(dir,"settings.json"), "{\"uiLayoutVersion\":1,\"sidebarCollapsed\":false,\"inspectorCollapsed\":false,\"codexHome\":\"C:/codex-test\",\"selectedSessionId\":\"keep-chat\",\"followLatest\":true,\"showInternal\":true,\"reducedMotion\":false,\"collapsedIds\":[\"keep-branch\"],\"view\":\"list\"}");
 var migrated=store.Load();store.Save(migrated);
 if(!migrated.SidebarCollapsed || !migrated.InspectorCollapsed || migrated.CodexHome!="C:/codex-test" || migrated.SelectedSessionId!="keep-chat" || !migrated.FollowLatest || !migrated.ShowInternal || migrated.ReducedMotion || migrated.View!="list" || migrated.CollapsedIds[0]!="keep-branch") throw new Exception("migration discarded observation preferences");
 File.WriteAllText(Path.Combine(dir,"settings.json"), "{\"uiLayoutVersion\":2,\"sidebarCollapsed\":false,\"inspectorCollapsed\":false,\"activityCollapsed\":false}");
 store.Save(store.Load());
 using(var second=System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(dir,"settings.json")))) { if(second.RootElement.GetProperty("sidebarCollapsed").GetBoolean() || second.RootElement.GetProperty("inspectorCollapsed").GetBoolean() || second.RootElement.GetProperty("activityCollapsed").GetBoolean()) throw new Exception("scene-first defaults repeated after explicit panel choices"); }
 File.WriteAllText(Path.Combine(dir,"settings.json"), "{bad"); if(!store.Load().ReducedMotion) throw new Exception("invalid settings fallback");
 var o=LaunchOptions.Parse(["--data-dir",dir,"--codex-home","test-home","--smoke-test"]); if(o.DataDir!=dir || o.CodexHome!="test-home" || !o.SmokeTest) throw new Exception("arguments");
 try { LaunchOptions.Parse(["--screenshot"]); throw new Exception("missing argument accepted"); } catch(ArgumentException) {}
 File.WriteAllText(Path.Combine(dir,"settings.json"), "{}"); if(!store.Load().ReducedMotion) throw new Exception("partial settings lost system motion default");
 foreach(var json in new[]{"{\"codexHome\":\"\"}", "{\"codexHome\":\"a\\u0000b\"}"}) { File.WriteAllText(Path.Combine(dir,"settings.json"),json); if(store.Load().CodexHome is not null) throw new Exception("invalid source path accepted"); }
 var schedule=new ScanSchedule(TimeSpan.FromMilliseconds(350));
 using var stormStop=new CancellationTokenSource(); var storm=Task.Run(async()=> { while(!stormStop.IsCancellationRequested) { schedule.Changed(); await Task.Delay(10); } }); var timer=System.Diagnostics.Stopwatch.StartNew(); await schedule.WaitAsync(CancellationToken.None); stormStop.Cancel(); await storm; if(timer.ElapsedMilliseconds<250) throw new Exception("watcher storm bypassed minimum cadence");
 timer.Restart(); var pending=schedule.WaitAsync(CancellationToken.None); await Task.Delay(30); schedule.Rescan(); await pending; if(timer.ElapsedMilliseconds>200) throw new Exception("manual rescan delayed");
 Console.WriteLine("PASS settings, arguments and scan cadence");
} finally { Directory.Delete(dir,true); }






