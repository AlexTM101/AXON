using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Axon.Core;

/// <summary>Read-only, incremental local Codex session observer. Scan is serialized internally.</summary>
public sealed class CodexObserver : IDisposable
{
    readonly ObserverOptions options;
    readonly string home;
    readonly object gate = new();
    readonly Dictionary<string, ObservedFile> files = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, IndexTitle> titles = new(StringComparer.Ordinal);
    RolloutReader index = new();
    IReadOnlySet<string> indexedActiveIds = new HashSet<string>(StringComparer.Ordinal);
    bool titleRecoveryPending;
    int indexMalformed;
    long scanOrder;
    bool disposed;
    string? selectedRoot; int historyLimit;

    public CodexObserver(ObserverOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (options.RecentDays < 1 || options.MaxEvents < 1) throw new ArgumentOutOfRangeException(nameof(options));
        this.options = options;
        home = System.IO.Path.GetFullPath(Environment.ExpandEnvironmentVariables(options.CodexHome));
    }

    public void ConfigureSelection(string? rootId, bool loadOlder = false)
    {
        lock (gate) {
            if (selectedRoot != rootId) { selectedRoot = rootId; historyLimit = options.MaxEvents; foreach (var f in files.Values) f.ResetHistory(); }
            else if (loadOlder && rootId != null) historyLimit = Math.Min(6000, historyLimit + options.MaxEvents);
        }
    }
    public ObserverSnapshot Scan(DateTimeOffset? now = null)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            var at = now ?? DateTimeOffset.UtcNow;
            if (!Directory.Exists(home))
            {
                files.Clear(); ResetIndex();
                return Snapshot(at, "missing", "Codex folder is unavailable.");
            }
            var error = false;
            var sessionFolders = new[] { System.IO.Path.Combine(home, "sessions"), System.IO.Path.Combine(home, "archived_sessions") };
            var discovered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var sessionFolder in sessionFolders)
            if (Directory.Exists(sessionFolder))
            {
                try
                {
                    
                    foreach (var path in Directory.EnumerateFiles(sessionFolder, "*.jsonl", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = false, AttributesToSkip = FileAttributes.ReparsePoint }))
                    {
                        try
                        {
                            
                            discovered.Add(path);
                            if (!files.TryGetValue(path, out var file)) files[path] = file = new(path, File.GetLastWriteTimeUtc(path) < at.AddDays(-options.RecentDays).UtcDateTime ? 1 : options.MaxEvents);
                            file.LastWrite = File.GetLastWriteTimeUtc(path);
                        }
                        catch (Exception ex) when (IsSourceError(ex)) { error = true; }
                    }
                }
                catch (Exception ex) when (IsSourceError(ex)) { error = true; }
            }
            var byteBudget = 8 * 1024 * 1024;
            foreach (var pair in files.Where(kv => discovered.Contains(kv.Key)).OrderBy(kv => kv.Value.ScanOrder).ThenByDescending(kv => kv.Value.LastWrite))
            {
                if (byteBudget <= 0) break;
                var file = pair.Value;
                try
                {
                    file.Reader.Read(pair.Key, file.Reset, (line, row) => file.Reducer.Consume(line, row), Math.Min(byteBudget, 512 * 1024));
                    byteBudget -= file.Reader.LastReadBytes;
                    file.ScanOrder = ++scanOrder;
                }
                catch (Exception ex) when (IsSourceError(ex)) { error = true; }
            }
            // On a partial enumeration error, retain the previous tree until a complete reconciliation.
            if (!error) foreach (var path in files.Keys.Where(path => !discovered.Contains(path)).ToArray()) files.Remove(path);
            var activeIds = files.Values.SelectMany(file => file.Reducer.Children.Keys
                .Append(file.Reducer.Id).Append(file.Reducer.ParentId)).OfType<string>().ToHashSet(StringComparer.Ordinal);
            ReadIndex(ref error, activeIds);
            return Snapshot(at, error ? "error" : files.Values.Any(f => f.Reducer.Id != null) ? "connected" : "empty",
                error ? "Some local session data could not be read. Retrying automatically." : null);
        }
    }

    void ReadIndex(ref bool error, IReadOnlySet<string> activeIds)
    {
        var path = System.IO.Path.Combine(home, "session_index.jsonl");
        if (!File.Exists(path)) { ResetIndex(); return; }
        if (activeIds.Any(id => !indexedActiveIds.Contains(id) && !titles.ContainsKey(id)))
            titleRecoveryPending = true;
        if (titleRecoveryPending && index.IsCaughtUp)
        {
            // Coalesce new recovery needs until this pass reaches EOF. Continuous
            // arrivals must not repeatedly rewind and starve later/appended rows.
            index.Rewind(); indexMalformed = 0; titleRecoveryPending = false;
        }
        indexedActiveIds = activeIds;
        try
        {
            index.Read(path, () => { titles.Clear(); indexMalformed = 0; }, (line, _) =>
            {
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var row = document.RootElement;
                    var id = EventReducer.Clean(EventReducer.Text(row, "id"), 160);
                    var title = EventReducer.Clean(EventReducer.Text(row, "thread_name"), 180);
                    if (id != null && title != null)
                    {
                        var updatedAt = EventReducer.Time(row, "updated_at");
                        if (!titles.TryGetValue(id, out var previous) || Nullable.Compare(updatedAt, previous.UpdatedAt) >= 0)
                            titles[id] = new(title, updatedAt);
                    }
                }
                catch (JsonException) { indexMalformed++; }
            }, useInitialTail: false);
        }
        catch (Exception ex) when (IsSourceError(ex)) { error = true; }
        // Active graph titles are protected; unrelated lifetime index history has
        // a fixed ceiling and retains the newest timestamps, not physical row order.
        foreach (var id in titles.Where(pair => !activeIds.Contains(pair.Key))
            .OrderByDescending(pair => pair.Value.UpdatedAt).ThenBy(pair => pair.Key, StringComparer.Ordinal)
            .Skip(4096).Select(pair => pair.Key).ToArray()) titles.Remove(id);
    }

    void ResetIndex()
    {
        // The cursor and its derived cache form one unit. An unchanged file that
        // returns after a folder/index hiatus must be consumed from the beginning.
        index = new(); titles.Clear(); indexMalformed = 0;
        indexedActiveIds = new HashSet<string>(StringComparer.Ordinal);
        titleRecoveryPending = false;
    }

    ObserverSnapshot Snapshot(DateTimeOffset now, string state, string? message)
    {
        var chosenFiles = files.Values.Where(f => f.Reducer.Id != null).GroupBy(f => f.Reducer.Id!, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.OrderByDescending(f => f.LastWrite).ThenByDescending(f => f.Reducer.LastEventAt).First(), StringComparer.Ordinal);
        var reducers = chosenFiles.ToDictionary(kv => kv.Key, kv => kv.Value.Reducer, StringComparer.Ordinal);
        var nodes = reducers.Values.SelectMany(r => r.Children.Values)
            .GroupBy(child => child.Id, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.OrderByDescending(child => child.At).First(), StringComparer.Ordinal);
        // A real rollout is authoritative, including later turns after parent completion.
        foreach (var (id, reducer) in reducers)
        {
            nodes.TryGetValue(id, out var reported);
            nodes[id] = new(id, reducer.ParentId ?? (reducer.IsExplicitRoot && (titles.ContainsKey(id) || reported?.Path == "/root") ? null : reported?.ParentId), reducer.Path, reducer.State, reducer.LastEventAt);
        }
        foreach (var (id, reducer) in reducers)
        {
            if (nodes[id].ParentId != null || reducer.GroupId == null || reducer.Path == "/root") continue;
            var separator = reducer.Path.TrimEnd('/').LastIndexOf('/');
            if (separator <= 0) continue;
            var parentPath = reducer.Path[..separator];
            var candidates = reducers.Values.Where(candidate => candidate.Id != id && candidate.GroupId == reducer.GroupId && candidate.Path == parentPath).Take(2).ToArray();
            if (candidates.Length == 1) nodes[id] = nodes[id] with { ParentId = candidates[0].Id };
        }
        foreach (var start in nodes.Keys.OrderBy(x => x, StringComparer.Ordinal)) {
 var chain = new List<string>(); var seen = new HashSet<string>(StringComparer.Ordinal); var cur = start;
 while (nodes.TryGetValue(cur, out var n) && n.ParentId != null) {
  if (!seen.Add(cur)) { var cut = chain.Skip(chain.IndexOf(cur)).Min(StringComparer.Ordinal)!; nodes[cut] = nodes[cut] with { ParentId = null }; break; }
  chain.Add(cur); cur = n.ParentId;
 }
}
        var agents = new List<AgentView>();
        foreach (var (id, node) in nodes)
        {
            reducers.TryGetValue(id, out var reducer);
            var (root, depth) = Resolve(id, nodes);
            var name = node.ParentId != null && reducer?.Nickname != null ? reducer.Nickname : titles.TryGetValue(id, out var title) ? title.Title : Humanize(node.Path, node.ParentId == null ? "Session" : "Agent");
            var freshness = !node.At.HasValue ? "unknown" : now - node.At.Value >= TimeSpan.FromSeconds(45) ? "stale" : "recent";
            agents.Add(new(id, node.ParentId, root, name, node.Path, depth, node.State, freshness, node.At, reducer?.LastTool, reducer?.Internal == true || IsInternal(node.Path), reducer?.ToolCount ?? 0));
        }
        var sessions = agents.GroupBy(a => a.RootId, StringComparer.Ordinal).Select(group =>
        {
            var id = group.Key;
            var title = titles.TryGetValue(id, out var indexTitle) ? indexTitle.Title : group.FirstOrDefault(a => a.Id == id)?.Name ?? "Unobserved parent";
            var observedAt = group.Max(a => a.LastEventAt);
            var updatedAt = indexTitle?.UpdatedAt is DateTimeOffset indexed && (!observedAt.HasValue || indexed > observedAt) ? indexed : observedAt;
            return new SessionView(id, title, updatedAt, group.Count());
        }).OrderByDescending(s => s.UpdatedAt).ThenBy(s => s.Id, StringComparer.Ordinal).ToArray();
                var history = reducers.Values.SelectMany(r => r.Events).OrderBy(e => e.At).ThenBy(e => e.Id, StringComparer.Ordinal).TakeLast(options.MaxEvents).ToArray();
        HistoryView? historyInfo = null;
        if (selectedRoot != null) {
            var ids = agents.Where(a => a.RootId == selectedRoot).Select(a => a.Id).ToHashSet(StringComparer.Ordinal);
            var selectedFiles = chosenFiles.Values.Where(f => f.Reducer.Id != null && ids.Contains(f.Reducer.Id)).ToArray();
            int budget = 2 * 1024 * 1024; bool loading = false;
            foreach (var file in selectedFiles) {
                try { if (budget > 0) { file.ReadHistory(Math.Min(budget, 512 * 1024)); budget -= file.HistoryReader.LastReadBytes; } }
                catch (Exception ex) when (IsSourceError(ex)) { loading = true; }
                if (!file.HistoryReader.IsCaughtUp || !file.HistoryStarted) loading = true;
            }
            // Do not merge tail and full-read IDs: row numbers differ after a tail seek.
            // Keep live state separate while full history catches up.
            var all = selectedFiles.Where(f => f.HistoryStarted).SelectMany(f => f.HistoryReducer.Events)
                .OrderBy(e => e.At).ThenBy(e => e.Id, StringComparer.Ordinal).ToArray();
            history = loading ? [] : all.TakeLast(historyLimit).ToArray();
            historyInfo = new(selectedRoot, loading, loading || (all.Length > historyLimit && historyLimit < 6000), historyLimit);
        }
        var plans = reducers.Where(kv => kv.Value.Plan.Count > 0).ToDictionary(kv => kv.Key, kv => (IReadOnlyList<PlanStepView>)kv.Value.Plan.ToArray(), StringComparer.Ordinal);
        if (selectedRoot != null && historyInfo?.Loading == false) foreach (var f in chosenFiles.Values.Where(f => f.HistoryStarted && f.HistoryReducer.Id != null && agents.Any(a => a.Id == f.HistoryReducer.Id && a.RootId == selectedRoot))) if (f.HistoryReducer.HasPlanUpdate) { if (f.HistoryReducer.Plan.Count > 0) plans[f.HistoryReducer.Id!] = f.HistoryReducer.Plan.ToArray(); else plans.Remove(f.HistoryReducer.Id!); }
        var malformed = files.Values.Sum(f => f.Reader.MalformedLines + f.Reducer.MalformedLines) + index.MalformedLines + indexMalformed;
        return new(1, now, new(state, home, message, malformed, files.Count), sessions,
            agents.OrderBy(a => a.Depth).ThenBy(a => a.Id, StringComparer.Ordinal).ToArray(), history, plans, historyInfo);
    }

    static (string Root, int Depth) Resolve(string id, IReadOnlyDictionary<string, ProvisionalAgent> reducers)
    {
        var chain = new List<string>();
        var positions = new Dictionary<string, int>(StringComparer.Ordinal);
        var current = id;
        while (true)
        {
            if (positions.TryGetValue(current, out var cycleStart))
                return (chain.Skip(cycleStart).Min(StringComparer.Ordinal)!, Math.Max(0, chain.Count - 1));
            positions[current] = chain.Count; chain.Add(current);
            if (!reducers.TryGetValue(current, out var reducer) || reducer.ParentId == null) return (current, chain.Count - 1);
            current = reducer.ParentId;
        }
    }
    static bool IsInternal(string path) => path.Split('/', StringSplitOptions.RemoveEmptyEntries).Any(segment => segment is "internal" or "compaction" or "guardian");
    static string Humanize(string path, string fallback)
    {
        var last = path.TrimEnd('/').Split('/').LastOrDefault();
        return last is null or "" or "root" ? fallback : last.Replace('_', ' ').Replace('-', ' ');
    }
    static bool IsSourceError(Exception ex) => ex is IOException or UnauthorizedAccessException or System.Security.SecurityException;
    public void Dispose() { lock (gate) { disposed = true; files.Clear(); titles.Clear(); } }
    sealed record IndexTitle(string Title, DateTimeOffset? UpdatedAt);
    sealed class ObservedFile
    {
        readonly string sourceId;
        readonly int max;
        public long ScanOrder { get; set; }
        public DateTime LastWrite { get; set; }
        public RolloutReader Reader { get; } = new();
        public EventReducer Reducer { get; private set; }
        public RolloutReader HistoryReader { get; private set; } = new();
        public EventReducer HistoryReducer { get; private set; } = null!;
        public bool HistoryStarted { get; private set; }
        readonly string path;
        public void ResetHistory() { HistoryReader = new(); HistoryReducer = new(sourceId, 6000); HistoryStarted = false; }
        public void ReadHistory(int budget) { HistoryStarted = true; HistoryReader.Read(path, () => HistoryReducer = new(sourceId, 6000), (line,row) => HistoryReducer.Consume(line,row), budget, useInitialTail:false); }
        public ObservedFile(string path, int max)
        {
            this.path = path; sourceId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(path)))[..16]; this.max = max;
            Reducer = new(sourceId, max); ResetHistory();
        }
        public void Reset() => Reducer = new(sourceId, max);
    }
}














