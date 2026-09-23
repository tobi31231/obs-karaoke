using System.Runtime.InteropServices;

namespace ObsKaraokeSetup;

internal static class LocalAssetReuse
{
    [DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(string destination, string source, IntPtr reserved);

    internal static bool CanReuse(string source, string expectedHash, string? installedHash) =>
        !string.IsNullOrEmpty(installedHash)
        && expectedHash.Equals(installedHash, StringComparison.OrdinalIgnoreCase)
        && Directory.Exists(source);

    internal static void CopyTree(string source, string destination, CancellationToken cancellationToken)
    {
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("기존 설치 폴더가 올바르지 않습니다.");
        Directory.CreateDirectory(destination);
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint };
        foreach (var file in Directory.EnumerateFiles(source, "*", options))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var target = Path.Combine(destination, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (!CreateHardLink(target, file, IntPtr.Zero)) File.Copy(file, target);
        }
    }
}
