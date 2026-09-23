using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;

namespace ObsKaraokeLauncher;

internal sealed class ReleaseManifest
{
    public string Version { get; set; } = "";
    public string InstallerSha256 { get; set; } = "";
    public List<ReleaseAsset> Assets { get; set; } = [];
}

internal sealed class ReleaseAsset
{
    public string Name { get; set; } = "";
    public string Sha256 { get; set; } = "";
}

internal sealed record AvailableUpdate(string Version, string InstallerSha256, Uri InstallerUri);

internal static class UpdateChecker
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    internal static async Task<AvailableUpdate?> CheckAsync(
        string installedManifestPath, Uri latestManifestUri, Uri installerUri,
        HttpClient client, CancellationToken cancellationToken)
    {
        if (!File.Exists(installedManifestPath)) return null;
        var installed = Parse(await File.ReadAllTextAsync(installedManifestPath, cancellationToken));
        if (installed is null) return null;

        using var request = new HttpRequestMessage(HttpMethod.Get, latestManifestUri);
        request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true };
        using var response = await client.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        var latest = Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        if (latest is null || !ValidHash(latest.InstallerSha256)) return null;

        var localAssets = installed.Assets.ToDictionary(item => item.Name, StringComparer.OrdinalIgnoreCase);
        var changed = latest.Assets.Count != localAssets.Count || latest.Assets.Any(asset =>
            !localAssets.TryGetValue(asset.Name, out var old)
            || !old.Sha256.Equals(asset.Sha256, StringComparison.OrdinalIgnoreCase));
        return changed ? new AvailableUpdate(latest.Version, latest.InstallerSha256, installerUri) : null;
    }

    internal static async Task DownloadInstallerAsync(
        AvailableUpdate update, string destination, HttpClient client, CancellationToken cancellationToken,
        IProgress<(long Downloaded, long? Total)>? progress = null)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        try
        {
            using var response = await client.GetAsync(
                update.InstallerUri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            response.EnsureSuccessStatusCode();
            await using (var file = new FileStream(destination, FileMode.Create, FileAccess.Write,
                             FileShare.None, 1024 * 1024, useAsync: true))
            {
                await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
                var buffer = new byte[1024 * 1024];
                long downloaded = 0;
                int count;
                while ((count = await source.ReadAsync(buffer, cancellationToken)) > 0)
                {
                    await file.WriteAsync(buffer.AsMemory(0, count), cancellationToken);
                    downloaded += count;
                    progress?.Report((downloaded, response.Content.Headers.ContentLength));
                }
            }
            await using var verify = File.OpenRead(destination);
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(verify, cancellationToken));
            if (!actual.Equals(update.InstallerSha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("설치 파일 검증에 실패했습니다.");
        }
        catch
        {
            File.Delete(destination);
            throw;
        }
    }

    private static ReleaseManifest? Parse(string json)
    {
        try
        {
            var manifest = JsonSerializer.Deserialize<ReleaseManifest>(json, JsonOptions);
            if (manifest?.Assets is not { Count: > 0 }) return null;
            if (manifest.Assets.Any(asset => asset is null
                    || string.IsNullOrWhiteSpace(asset.Name) || !ValidHash(asset.Sha256)))
                return null;
            return manifest;
        }
        catch (JsonException) { return null; }
        catch (ArgumentException) { return null; }
    }

    private static bool ValidHash(string value) =>
        value.Length == 64 && value.All(Uri.IsHexDigit);
}
