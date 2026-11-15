using System.IO;
using System.Text.Json;

namespace Axon.Desktop;

public sealed class Settings
{
    public string? CodexHome { get; set; }
    public string? SelectedSessionId { get; set; }
    public bool FollowLatest { get; set; }
    public bool ReducedMotion { get; set; }
    public bool ShowInternal { get; set; }
    public bool SidebarCollapsed { get; set; } = true;
    public bool InspectorCollapsed { get; set; } = true;
    public bool ActivityCollapsed { get; set; } = true;
    public int UiLayoutVersion { get; set; } = 2;
    public string[] CollapsedIds { get; set; } = [];
    public string View { get; set; } = "map";
}

public sealed class SettingsStore(string dir, bool systemReducedMotion)
{
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };
    readonly string path = Path.Combine(dir, "settings.json");

    public Settings Load()
    {
        try
        {
            var text = File.ReadAllText(path);
            using var document = JsonDocument.Parse(text);
            var settings = JsonSerializer.Deserialize<Settings>(text, Json) ?? throw new JsonException();
            if (!document.RootElement.EnumerateObject().Any(p => p.Name.Equals("reducedMotion", StringComparison.OrdinalIgnoreCase)))
                settings.ReducedMotion = systemReducedMotion;
            if (!document.RootElement.EnumerateObject().Any(p => p.Name.Equals("uiLayoutVersion", StringComparison.OrdinalIgnoreCase)))
                settings.UiLayoutVersion = 0;
            return Normalize(settings);
        }
        catch { return new Settings { ReducedMotion = systemReducedMotion }; }
    }

    public void Save(Settings value)
    {
        Directory.CreateDirectory(dir);
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temp, JsonSerializer.Serialize(Normalize(value), Json));
            File.Move(temp, path, true);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }

    public static Settings Normalize(Settings settings)
    {
        if (settings.UiLayoutVersion < 2)
        {
            settings.SidebarCollapsed = true;
            settings.InspectorCollapsed = true;
            settings.ActivityCollapsed = true;
            settings.UiLayoutVersion = 2;
        }
        settings.View = settings.View is "list" ? "list" : "map";
        settings.CollapsedIds = (settings.CollapsedIds ?? []).Where(x => x is not null && x.Length <= 512).Distinct().Take(2000).ToArray();
        if (settings.CodexHome is { } home)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(home) || home.Length > 4096) settings.CodexHome = null;
                else _ = Path.GetFullPath(home);
            }
            catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { settings.CodexHome = null; }
        }
        if (settings.SelectedSessionId?.Length > 512) settings.SelectedSessionId = null;
        return settings;
    }
}
