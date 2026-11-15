using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Axon.Core;

// A byte-oriented tailer. UTF-8 is decoded only after a complete newline is present.
internal sealed class RolloutReader
{
    const int MaxLineBytes = 1024 * 1024;
    readonly List<byte> pending = [];
    byte[] checkpoint = [];
    byte[] prefix = [];
    bool tailPending = true;
    bool intentionalSkip;
    bool rewindRequested;
    public int LastReadBytes { get; private set; }
    public bool IsCaughtUp { get; private set; } = true;
    string? identity;
    long offset;
    bool dropping;
    int line;
    public int MalformedLines { get; private set; }

    public void Rewind() => rewindRequested = true;

    public void Read(string path, Action reset, Action<string, int> consume, int maxBytes = 512 * 1024, bool useInitialTail = true)
    {
        LastReadBytes = 0;
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete, 65536, FileOptions.SequentialScan);
        var currentIdentity = Identity(stream, path);
        var replaced = identity != null && (identity != currentIdentity || stream.Length < offset || !CheckpointMatches(stream) || !PrefixMatches(stream));
        if (replaced)
        {
            ResetCursor(); reset();
        }
        else if (rewindRequested) ResetCursor();
        identity = currentIdentity;
        stream.Position = offset;
        var remaining = stream.Length - offset;
        var buffer = new byte[65536];
        while (remaining > 0 && LastReadBytes < maxBytes)
        {
            // Keep the metadata prefix, then jump to recent history on first load.
            if (useInitialTail && tailPending && line > 0)
            {
                tailPending = false;
                if (stream.Length - offset > 256 * 1024)
                {
                    offset = stream.Length - 256 * 1024; stream.Position = offset; remaining = stream.Length - offset;
                    pending.Clear(); dropping = true; intentionalSkip = true;
                }
            }
            var read = stream.Read(buffer, 0, (int)Math.Min(Math.Min(buffer.Length, remaining), maxBytes - LastReadBytes));
            if (read == 0) break;
            offset += read; remaining -= read; LastReadBytes += read;
            for (var i = 0; i < read; i++)
            {
                if (buffer[i] == 10)
                {
                    line++;
                    if (dropping) { if (!intentionalSkip) MalformedLines++; }
                    else
                    {
                        try
                        {
                            var text = new UTF8Encoding(false, true).GetString(pending.ToArray()).TrimEnd('\r');
                            if (line == 1) text = text.TrimStart('\uFEFF');
                            if (!string.IsNullOrWhiteSpace(text)) consume(text, line);
                        }
                        catch (DecoderFallbackException) { MalformedLines++; }
                    }
                    pending.Clear(); if (pending.Capacity > 65536) pending.TrimExcess(); dropping = false; intentionalSkip = false;
                }
                else if (!dropping)
                {
                    if (pending.Count >= MaxLineBytes) { pending.Clear(); dropping = true; }
                    else pending.Add(buffer[i]);
                }
            }
        }
        // Initial loading ends once we catch up, including short/empty files. Future
        // appends are always streamed from the saved offset and must never tail-seek.
        if (remaining == 0) tailPending = false;
        var size = (int)Math.Min(offset, 128);
        checkpoint = new byte[size]; stream.Position = offset - size;
        stream.ReadExactly(checkpoint);
        var prefixSize = (int)Math.Min(offset, 256);
        prefix = new byte[prefixSize]; stream.Position = 0; stream.ReadExactly(prefix);
        IsCaughtUp = remaining == 0;
    }

    void ResetCursor()
    {
        offset = 0; line = 0; pending.Clear(); checkpoint = []; prefix = [];
        dropping = false; tailPending = true; intentionalSkip = false;
        MalformedLines = 0; rewindRequested = false;
        IsCaughtUp = false;
    }

    bool PrefixMatches(FileStream stream)
    {
        if (prefix.Length == 0) return true;
        if (stream.Length < prefix.Length) return false;
        stream.Position = 0; var current = new byte[prefix.Length]; stream.ReadExactly(current);
        return current.AsSpan().SequenceEqual(prefix);
    }

    bool CheckpointMatches(FileStream stream)
    {
        if (checkpoint.Length == 0) return true;
        if (stream.Length < offset) return false;
        stream.Position = offset - checkpoint.Length;
        var current = new byte[checkpoint.Length]; stream.ReadExactly(current);
        return current.AsSpan().SequenceEqual(checkpoint);
    }

    static string Identity(FileStream stream, string path)
    {
        if (OperatingSystem.IsWindows() && GetFileInformationByHandle(stream.SafeFileHandle, out var info))
            return $"{info.Volume}:{info.IndexHigh}:{info.IndexLow}";
        return File.GetCreationTimeUtc(path).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    [StructLayout(LayoutKind.Sequential)]
    struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
}


