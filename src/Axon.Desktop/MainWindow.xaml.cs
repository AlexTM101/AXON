using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Windows;
using Axon.Core;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
namespace Axon.Desktop;
public partial class MainWindow : Window {
 const string Origin="https://axon.local/"; const string InstallUrl=WebViewInstall.Url;
 static readonly JsonSerializerOptions Json=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase,PropertyNameCaseInsensitive=true};
 readonly LaunchOptions options; readonly string dataDir; readonly SettingsStore store; Settings settings; readonly CancellationTokenSource stop=new(); readonly SemaphoreSlim scanLock=new(1,1); ScanSchedule schedule = new(TimeSpan.FromSeconds(1)); int generation; bool ready; readonly HistoryRequests historyRequests = new(); ObserverSnapshot? last; FileSystemWatcher? watcher;
 public MainWindow(LaunchOptions options) { InitializeComponent(); this.options=options; dataDir=Path.GetFullPath(options.DataDir ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AXON")); Directory.CreateDirectory(dataDir); store=new(dataDir,!SystemParameters.ClientAreaAnimation); settings=store.Load(); var wa=SystemParameters.WorkArea; Width=Math.Min(Width,wa.Width); Height=Math.Min(Height,wa.Height); MinWidth=Math.Min(MinWidth,wa.Width); MinHeight=Math.Min(MinHeight,wa.Height); Loaded+=Start; StateChanged+=(_,_)=>Send("hostStatus",new { minimized=WindowState==WindowState.Minimized }); Closed+=(_,_)=> { stop.Cancel(); watcher?.Dispose(); }; }
 async void Start(object sender,RoutedEventArgs e) { try { string web=ExtractWeb(); var env=await CoreWebView2Environment.CreateAsync(null,Path.Combine(dataDir,"webview")); await Browser.EnsureCoreWebView2Async(env); var core=Browser.CoreWebView2; core.Settings.IsNonClientRegionSupportEnabled=true; core.Settings.AreDevToolsEnabled=false; core.Settings.AreDefaultContextMenusEnabled=false; core.Settings.IsStatusBarEnabled=false; core.SetVirtualHostNameToFolderMapping("axon.local",web,CoreWebView2HostResourceAccessKind.DenyCors); core.NavigationStarting+=(_,a)=> { if(!a.Uri.StartsWith(Origin,StringComparison.OrdinalIgnoreCase)) a.Cancel=true; }; core.NewWindowRequested+=(_,a)=>a.Handled=true; core.DownloadStarting+=(_,a)=>a.Cancel=true; core.PermissionRequested+=(_,a)=>a.State=CoreWebView2PermissionState.Deny; core.WebMessageReceived+=OnMessage; core.ProcessFailed+=(_,_)=> { ready=false; MessageBox.Show("Не удалось отобразить интерфейс AXON. Перезапустите приложение.","AXON",MessageBoxButton.OK,MessageBoxImage.Error); }; core.Navigate(Origin+"index.html"); if(options.SmokeTest) _=TimeoutSmoke(); } catch(Exception ex) { WriteDiagnostic("startup-error",ex.GetType().Name); if (MessageBox.Show("Не удалось запустить интерфейс AXON. Возможно, отсутствует Microsoft Edge WebView2 Runtime. Открыть официальную страницу установки?", "AXON", MessageBoxButton.YesNo, MessageBoxImage.Warning) == MessageBoxResult.Yes) { try { Process.Start(new ProcessStartInfo(InstallUrl) { UseShellExecute = true }); } catch { MessageBox.Show("Не удалось открыть браузер. Адрес: " + InstallUrl, "AXON"); } } Application.Current.Shutdown(1); } }
 string ExtractWeb() { string dir=Path.Combine(dataDir,"ui"); Directory.CreateDirectory(dir); var asm=Assembly.GetExecutingAssembly(); foreach(var name in asm.GetManifestResourceNames().Where(n=>n.StartsWith("Axon.Web/",StringComparison.Ordinal))) { var relative=name[9..].Replace('/',Path.DirectorySeparatorChar).Replace('\\',Path.DirectorySeparatorChar); var file=Path.GetFullPath(Path.Combine(dir,relative)); if(!file.StartsWith(Path.GetFullPath(dir)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException(); Directory.CreateDirectory(Path.GetDirectoryName(file)!); using var input=asm.GetManifestResourceStream(name)!; using var output=File.Create(file); input.CopyTo(output); } if(!File.Exists(Path.Combine(dir,"index.html"))) throw new InvalidOperationException(); return dir; }
 void OnMessage(object? sender,CoreWebView2WebMessageReceivedEventArgs e) { if(!e.Source.StartsWith(Origin,StringComparison.OrdinalIgnoreCase) || e.WebMessageAsJson.Length>100000) return; try { using var doc=JsonDocument.Parse(e.WebMessageAsJson); var root=doc.RootElement; if(root.ValueKind!=JsonValueKind.Object || !root.TryGetProperty("type",out var t) || t.ValueKind!=JsonValueKind.String) return; switch(t.GetString()) { case "ready": ready=true; Send("settings",settings); RestartObserver(); break; case "minimize": WindowState=WindowState.Minimized; break; case "maximize": WindowState=WindowState==WindowState.Maximized?WindowState.Normal:WindowState.Maximized; break; case "close": Close(); break; case "chooseFolder": ChooseFolder(); break; case "rescan": schedule.Rescan(); break; case "selectHistory": historyRequests.Select(root.TryGetProperty("payload",out var selected) && selected.ValueKind==JsonValueKind.String ? selected.GetString() : null); schedule.Rescan(); break; case "loadOlder": historyRequests.LoadOlder(); schedule.Rescan(); break; case "saveSettings": if(root.TryGetProperty("payload",out var p) && p.ValueKind==JsonValueKind.Object) { var updated=JsonSerializer.Deserialize<Settings>(p.GetRawText(),Json); if(updated is not null) { updated.CodexHome=settings.CodexHome; settings=SettingsStore.Normalize(updated); Save(); } } break; case "openExternal": if(root.TryGetProperty("url",out var u) && u.ValueKind==JsonValueKind.String && WebViewInstall.IsAllowed(u.GetString())) Process.Start(new ProcessStartInfo(InstallUrl){UseShellExecute=true}); break; } } catch(JsonException) {} catch { Send("hostStatus",new {message="Не удалось выполнить действие. Проверьте доступ к папке."}); } }
 void Save() { try { store.Save(settings); } catch { Send("hostStatus",new {message="Не удалось сохранить настройки."}); } }
 void ChooseFolder() { var dlg=new OpenFolderDialog { Title="Выберите папку Codex", Multiselect=false }; if(dlg.ShowDialog(this)==true) { settings.CodexHome=dlg.FolderName; settings.SelectedSessionId=null; Save(); Send("settings",settings); RestartObserver(); } }
 string SourcePath()=>options.CodexHome ?? settings.CodexHome ?? Environment.GetEnvironmentVariable("CODEX_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".codex");
 void RestartObserver()
 {
     int gen = Interlocked.Increment(ref generation);
     watcher?.Dispose();
     historyRequests.BeginGeneration(gen, settings.SelectedSessionId);
     watcher = null;
     var path = SourcePath();
     var currentSchedule = new ScanSchedule(TimeSpan.FromSeconds(1));
     schedule = currentSchedule;
     try
     {
         if (Directory.Exists(path))
         {
             watcher = new FileSystemWatcher(path)
             {
                 IncludeSubdirectories = true,
                 NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.DirectoryName,
                 EnableRaisingEvents = true
             };
             watcher.Changed += (_, _) => currentSchedule.Changed();
             watcher.Created += (_, _) => currentSchedule.Changed();
             watcher.Deleted += (_, _) => currentSchedule.Changed();
             watcher.Renamed += (_, _) => currentSchedule.Changed();
             watcher.Error += (_, _) => currentSchedule.Changed();
         }
     }
     catch { /* Periodic reconciliation still works without a watcher. */ }
     _ = Task.Run(() => Observe(path, gen, currentSchedule));
 }

 async Task Observe(string path, int gen, ScanSchedule currentSchedule)
 {
     try
     {
         using var observer = new CodexObserver(new ObserverOptions(path));
         while (!stop.IsCancellationRequested && gen == generation)
         {
             ObserverSnapshot snapshot;
             await scanLock.WaitAsync(stop.Token);
                          try {
                 if (gen != Volatile.Read(ref generation) || stop.IsCancellationRequested) break;
                 var claim = historyRequests.Claim(gen);
                 if (claim is null) break;
                 observer.ConfigureSelection(claim.RootId);
                 for (var i = 0; i < claim.OlderCount; i++) observer.ConfigureSelection(claim.RootId, true);
                 snapshot = observer.Scan();
             }
             finally { scanLock.Release(); }
             if (gen != generation || stop.IsCancellationRequested) break;
             await Dispatcher.InvokeAsync(() =>
             {
                 if (gen != generation || !ready) return;
                 last = snapshot;
                 Send("snapshot", snapshot);
                 if (options.SmokeTest || options.Screenshot is not null) _ = FinishChecks(snapshot);
             });
             await currentSchedule.WaitAsync(stop.Token);
         }
     }
     catch (OperationCanceledException) { }
     catch (Exception ex)
     {
         if (!stop.IsCancellationRequested && gen == generation)
             await Dispatcher.InvokeAsync(() =>
             {
                 Send("hostStatus", new { message = "Не удалось прочитать историю Codex. Выберите другую папку." });
                 WriteDiagnostic("observer-error", ex.GetType().Name);
                 if (options.SmokeTest) Application.Current.Shutdown(1);
             });
     }
 }
 void Send(string type,object payload) { if(ready && Browser.CoreWebView2 is not null) Browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new {type,payload},Json)); }
 bool checking;
 async Task FinishChecks(ObserverSnapshot snapshot) { if(checking) return; checking=true; try { await Task.Delay(500); var result=await Browser.CoreWebView2.ExecuteScriptAsync("JSON.stringify({dom:!!document.querySelector('#canvas')&&!!document.querySelector('#sourceLabel'),label:document.querySelector('#sourceLabel')?.textContent,graph:typeof window.AxonGraph==='object',receive:typeof window.axonReceive==='function',innerWidth,innerHeight,devicePixelRatio})"); var decoded=JsonSerializer.Deserialize<string>(result); using var doc=JsonDocument.Parse(decoded!); bool ok=doc.RootElement.GetProperty("dom").GetBoolean() && doc.RootElement.GetProperty("graph").GetBoolean() && doc.RootElement.GetProperty("receive").GetBoolean() && doc.RootElement.GetProperty("label").GetString() != "Подключение"; if(options.Screenshot is not null) { var path=Path.GetFullPath(options.Screenshot); Directory.CreateDirectory(Path.GetDirectoryName(path)!); await using var f=File.Create(path); await Browser.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,f); } WriteDiagnostic("smoke",$"ok={ok}; source={snapshot.Source.State}; sessions={snapshot.Sessions.Count}; agents={snapshot.Agents.Count}; events={snapshot.Events.Count}; files={snapshot.Source.FilesObserved}; window={ActualWidth:F0}x{ActualHeight:F0}; client={Browser.ActualWidth:F0}x{Browser.ActualHeight:F0}; minimum={MinWidth:F0}x{MinHeight:F0}; viewport={doc.RootElement.GetProperty("innerWidth").GetInt32()}x{doc.RootElement.GetProperty("innerHeight").GetInt32()}; dpr={doc.RootElement.GetProperty("devicePixelRatio").GetDouble()}"); if(options.SmokeTest) Application.Current.Shutdown(ok?0:1); } catch(Exception ex) { WriteDiagnostic("smoke-error",ex.GetType().Name); if(options.SmokeTest) Application.Current.Shutdown(1); } }
 async Task TimeoutSmoke() { await Task.Delay(TimeSpan.FromSeconds(25)); if(last is null) { WriteDiagnostic("smoke-error","timeout"); Application.Current.Shutdown(1); } }
 void WriteDiagnostic(string name,string content) { try { File.WriteAllText(Path.Combine(dataDir,name+".txt"),content); } catch {} }
}




