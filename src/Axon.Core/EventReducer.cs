using System.Text.Json;
using System.Text.RegularExpressions;

namespace Axon.Core;

// Only selected metadata is retained. JsonDocument and all message/argument/result bodies
// stay in this boundary and are discarded after each row.
internal sealed class EventReducer(string sourceId, int maxEvents)
{
    readonly Dictionary<string, string> pendingCalls = new(StringComparer.Ordinal);
    readonly HashSet<string> callIds = new(StringComparer.Ordinal);
    readonly Queue<string> callOrder = new();
    readonly HashSet<(string Kind, string Turn)> lifecycleIds = [];
    readonly Queue<(string Kind, string Turn)> lifecycleOrder = new();
    readonly HashSet<string> itemIds = new(StringComparer.Ordinal);
    readonly Queue<string> itemOrder = new();
    readonly List<ActivityView> events = [];
    readonly Dictionary<string, ProvisionalAgent> children = new(StringComparer.Ordinal);
    public IReadOnlyDictionary<string, ProvisionalAgent> Children => children;
    public string? Id { get; private set; }
    public string? ParentId { get; private set; }
    public bool IsExplicitRoot { get; private set; }
    public string? GroupId { get; private set; }
    public string Path { get; private set; } = "/root";
    public string? Nickname { get; private set; }
    public bool Internal { get; private set; }
    public string State { get; private set; } = "unknown";
    public DateTimeOffset? LastEventAt { get; private set; }
    public string? LastTool { get; private set; }
    public int ToolCount { get; private set; }
    public int MalformedLines { get; private set; }
    public IReadOnlyList<ActivityView> Events => events;
    public IReadOnlyList<PlanStepView> Plan { get; private set; } = [];
    public bool HasPlanUpdate { get; private set; }

    public void Consume(string line, int row)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("payload", out var p) || p.ValueKind != JsonValueKind.Object) return;
            var category = Text(root, "type");
            var type = Text(p, "type");
            var at = Time(root, "timestamp");
            if (category == "session_meta")
            {
                Id = Clean(Text(p, "id"), 160);
                GroupId = Clean(Text(p, "session_id"), 160);
                ParentId = Clean(Text(p, "parent_thread_id"), 160);
                Internal = false;
                IsExplicitRoot = p.TryGetProperty("source", out var sourceKind) && sourceKind.ValueKind == JsonValueKind.String && ParentId == null;
                if (p.TryGetProperty("source", out var source) && source.ValueKind == JsonValueKind.Object &&
                    source.TryGetProperty("subagent", out var subagent) && subagent.ValueKind == JsonValueKind.Object)
                {
                    Internal = Text(subagent, "other") == "guardian";
                    if (subagent.TryGetProperty("thread_spawn", out var spawn) && spawn.ValueKind == JsonValueKind.Object)
                    {
                        ParentId ??= Clean(Text(spawn, "parent_thread_id"), 160);
                        Path = Clean(Text(spawn, "agent_path"), 512) ?? "/root/agent";
                        Nickname = Clean(Text(spawn, "agent_nickname"), 120);
                    }
                }
                return;
            }
            if (Id == null) return;
            if (category == "event_msg")
            {
                var lifecycle = type switch
                {
                    "task_started" => "task_started",
                    "task_complete" or "task_completed" => "task_complete",
                    "turn_aborted" or "task_interrupted" or "task_cancelled" => "interrupted",
                    "error" or "task_failed" => "error",
                    _ => null
                };
                var turn = lifecycle == null ? null : Clean(Text(p, "turn_id"), 160);
                if (lifecycle != null && turn != null)
                {
                    var key = (lifecycle, turn);
                    if (!lifecycleIds.Add(key)) return;
                    lifecycleOrder.Enqueue(key);
                    if (lifecycleOrder.Count > 4096) lifecycleIds.Remove(lifecycleOrder.Dequeue());
                }
                switch (type)
                {
                    case "task_started": Change("started", "task_started", "Task started", at, row); return;
                    case "task_complete": case "task_completed": Change("completed", "task_complete", "Task completed", at, row); return;
                    case "turn_aborted": case "task_interrupted": case "task_cancelled": Change("interrupted", "interrupted", "Task interrupted", at, row); return;
                    case "error": case "task_failed": Change("error", "error", "Observed error", at, row); return;
                    case "plan_update": case "update_plan": ReadPlan(p); Touch(at); return;
                    case "item_completed": ReadItem(p, at, row); return;
                }
            }
            else if (category == "response_item")
            {
                switch (type)
                {
                    case "function_call": case "custom_tool_call":
                        var name = ToolName(Text(p, "name"));
                        if (name == null) return;
                        var call = Clean(Text(p, "call_id"), 160) ?? $"row:{row}";
                        if (!callIds.Add(call)) return;
                        callOrder.Enqueue(call);
                        if (callOrder.Count > 4096) callIds.Remove(callOrder.Dequeue());
                        if (!pendingCalls.TryAdd(call, name)) return;
                        if (pendingCalls.Count > 4096) pendingCalls.Remove(pendingCalls.Keys.First());
                        ToolCount++; LastTool = name; State = "tool";
                        Add("tool_started", "Tool started", at, row, name, "started");
                        if (name is "update_plan" or "plan_update") ReadPlanArgument(p);
                        return;
                    case "function_call_output": case "custom_tool_call_output":
                        var outputCall = Text(p, "call_id");
                        if (outputCall != null && pendingCalls.Remove(outputCall, out var tool))
                        {
                            if (State == "tool" && pendingCalls.Count == 0) State = "started";
                            Add("tool_completed", "Tool completed", at, row, tool, "completed");
                        }
                        return;
                    case "plan_update": case "update_plan": ReadPlan(p); Touch(at); return;
                }
            }
        }
        catch (JsonException) { MalformedLines++; }
    }

    void ReadItem(JsonElement p, DateTimeOffset? at, int row)
    {
        if (!p.TryGetProperty("item", out var item) || item.ValueKind != JsonValueKind.Object) return;
        var type = Text(item, "type");
        if (type is not ("SubAgentActivity" or "CommandExecution" or "McpToolCall" or "FileChange")) return;
        var id = Text(item, "id");
        if (id != null)
        {
            if (!itemIds.Add(id)) return;
            itemOrder.Enqueue(id);
            if (itemOrder.Count > 4096) itemIds.Remove(itemOrder.Dequeue());
        }
        if (type is "SubAgentActivity")
        {
            // Agent state comes from that agent's own rollout, never a parent's summary.
            var kind = Text(item, "kind");
            if (kind is "started" or "interacted" or "completed")
            {
                var childId = Clean(Text(item, "agent_thread_id"), 160);
                var childPath = Clean(Text(item, "agent_path"), 512) ?? "/root/agent";
                if (kind != "interacted" && childId != null && Id != null) children[childId] = new(childId, Id, childPath, kind == "completed" ? "completed" : "unknown", at);
                Add("agent_activity", "Agent activity", at, row);
            }
            return;
        }
        var tool = type == "McpToolCall" ? ToolName(Text(item, "tool")) ?? "mcp_tool" : type == "CommandExecution" ? "exec_command" : "file_change";
        var status = Text(item, "status");
        var failed = status is "failed" or "error" || (item.TryGetProperty("exit_code", out var exit) && exit.ValueKind == JsonValueKind.Number && exit.TryGetInt32(out var code) && code != 0);
        if (!pendingCalls.Values.Contains(tool, StringComparer.Ordinal)) ToolCount++;
        LastTool = tool;
        if (failed) State = "error";
        Add("tool_activity", failed ? "Tool failed" : "Tool activity", at, row, tool, failed ? "error" : "completed");
    }

    void ReadPlanArgument(JsonElement p)
    {
        if (!p.TryGetProperty("arguments", out var args)) return;
        if (args.ValueKind == JsonValueKind.Object) { ReadPlan(args); return; }
        if (args.ValueKind != JsonValueKind.String) return;
        try { using var document = JsonDocument.Parse(Text(p, "arguments")!); ReadPlan(document.RootElement); }
        catch (JsonException) { /* Invalid optional plan data is not exposed. */ }
    }

    void ReadPlan(JsonElement p)
    {
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("plan", out var plan) || plan.ValueKind != JsonValueKind.Array) return;
        var result = new List<PlanStepView>();
        foreach (var item in plan.EnumerateArray().Take(100))
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var step = Clean(Text(item, "step"), 500);
            var status = Text(item, "status");
            if (step != null && status is "pending" or "in_progress" or "completed") result.Add(new(step, status));
        }
        Plan = result; HasPlanUpdate = true;
    }

    void Change(string state, string kind, string label, DateTimeOffset? at, int row)
    { State = state; if (state is "completed" or "interrupted" or "error") pendingCalls.Clear(); Add(kind, label, at, row); }
    void Touch(DateTimeOffset? at) { if (at.HasValue && (!LastEventAt.HasValue || at > LastEventAt)) LastEventAt = at; }
    void Add(string kind, string label, DateTimeOffset? at, int row, string? tool = null, string? outcome = null)
    {
        Touch(at);
        // An absent source timestamp stays unknown; it must not become fresh on each scan.
        if (!at.HasValue || Id == null) return;
        events.Add(new($"{sourceId}:{row:D12}", Id, kind, label, at.Value, tool, outcome));
        if (events.Count > maxEvents) events.RemoveRange(0, events.Count - maxEvents);
    }
    internal static string? Text(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String) return null;
        try { return value.GetString(); }
        catch (InvalidOperationException ex)
        {
            // Escaped lone surrogates can parse as JSON but fail string decoding.
            // Normalize this row-local data error into the existing tolerant path.
            throw new JsonException("Invalid JSON string encoding.", ex);
        }
    }
    internal static DateTimeOffset? Time(JsonElement element, string name) => DateTimeOffset.TryParse(Text(element, name), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var value) ? value : null;
    internal static string? Clean(string? text, int length)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var clean = new string(text.Where(c => !char.IsControl(c)).Take(length).ToArray()).Trim();
        return clean.Length == 0 ? null : clean;
    }
    static string? ToolName(string? name) => name != null && name.Length <= 120 && Regex.IsMatch(name, "^[A-Za-z0-9_.:-]+$", RegexOptions.CultureInvariant) ? name : null;
}

internal sealed record ProvisionalAgent(string Id, string? ParentId, string Path, string State, DateTimeOffset? At);






