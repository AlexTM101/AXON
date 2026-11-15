namespace Axon.Desktop;
internal static class WebViewInstall {
 public const string Url = "https://developer.microsoft.com/en-us/microsoft-edge/webview2/";
 public static bool IsAllowed(string? url) => string.Equals(url, Url, StringComparison.Ordinal);
}
