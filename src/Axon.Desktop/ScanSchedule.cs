using System.Diagnostics;
namespace Axon.Desktop;

public sealed class ScanSchedule(TimeSpan minimumInterval)
{
    readonly SemaphoreSlim signal = new(0, 1);
    int manual;

    public void Changed() => Wake();
    public void Rescan() { Interlocked.Exchange(ref manual, 1); Wake(); }

    void Wake()
    {
        try { if (signal.CurrentCount == 0) signal.Release(); }
        catch (SemaphoreFullException) { }
    }

    public async Task<bool> WaitAsync(CancellationToken token)
    {
        var elapsed = Stopwatch.StartNew();
        var deadline = TimeSpan.FromTicks(minimumInterval.Ticks * 3);
        bool changed = false;
        while (true)
        {
            if (Interlocked.Exchange(ref manual, 0) != 0) return true;
            var target = changed ? minimumInterval : deadline;
            var remaining = target - elapsed.Elapsed;
            if (remaining <= TimeSpan.Zero) return changed;
            if (!await signal.WaitAsync(remaining, token)) return changed;
            if (Interlocked.Exchange(ref manual, 0) != 0) return true;
            changed = true;
        }
    }
}
