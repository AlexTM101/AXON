namespace Axon.Core;
public sealed record ObserverOptions(string CodexHome, int RecentDays = 14, int MaxEvents = 600);
public sealed record AgentView(string Id, string? ParentId, string RootId, string Name, string Path, int Depth, string State, string Freshness, DateTimeOffset? LastEventAt, string? LastTool, bool Internal, int ToolCount);
public sealed record SessionView(string Id, string Title, DateTimeOffset? UpdatedAt, int AgentCount);
public sealed record ActivityView(string Id, string AgentId, string Kind, string Label, DateTimeOffset At, string? Tool, string? Outcome);
public sealed record PlanStepView(string Step, string Status);
public sealed record SourceView(string State, string Path, string? Message, int MalformedLines, int FilesObserved);
public sealed record HistoryView(string? RootId, bool Loading, bool HasMore, int Limit);
public sealed record ObserverSnapshot(int Version, DateTimeOffset At, SourceView Source, IReadOnlyList<SessionView> Sessions, IReadOnlyList<AgentView> Agents, IReadOnlyList<ActivityView> Events, IReadOnlyDictionary<string, IReadOnlyList<PlanStepView>> Plans, HistoryView? History = null);

