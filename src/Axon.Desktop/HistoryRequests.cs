namespace Axon.Desktop;

// A selection and its pending requests are claimed as one generation-bound unit.
internal sealed class HistoryRequests
{
    readonly object gate = new();
    int generation, older;
    string? root;
    public void BeginGeneration(int value, string? selected) { lock (gate) { generation = value; root = selected; older = 0; } }
    public void Select(string? selected) { lock (gate) { root = selected; older = 0; } }
    public void LoadOlder() { lock (gate) { if (root != null && older < 6000) older++; } }
    public HistoryClaim? Claim(int value) { lock (gate) { if (generation != value) return null; var claim = new HistoryClaim(root, older); older = 0; return claim; } }
}
internal sealed record HistoryClaim(string? RootId, int OlderCount);
