using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

// ตัวห่อของ PhotoBoothSetup.exe
// หน้าที่เดียว: แตกชุดติดตั้งที่ฝังไว้ในตัวเองลง temp แล้วเรียก setup.ps1 ให้ทำงานจริง
// เขียนเป็นภาษาอังกฤษล้วนเพราะข้อความช่วงนี้ออกก่อนตั้ง code page ของคอนโซล
static class Setup
{
    const string PayloadResource = "payload.zip";

    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.Title = "Photo Booth Setup";

        string work = Path.Combine(Path.GetTempPath(), "PhotoBoothSetup-" + Guid.NewGuid().ToString("N"));
        try
        {
            Console.WriteLine();
            Console.WriteLine("  Unpacking Photo Booth setup...");
            Directory.CreateDirectory(work);
            Extract(work);

            string script = Path.Combine(work, "setup.ps1");
            if (!File.Exists(script))
            {
                Console.Error.WriteLine("  Setup package is incomplete: setup.ps1 is missing.");
                return 2;
            }

            var psi = new ProcessStartInfo
            {
                FileName = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "WindowsPowerShell\\v1.0\\powershell.exe"),
                UseShellExecute = false,
                WorkingDirectory = work,
            };
            psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"";
            foreach (string arg in args) psi.Arguments += " " + arg;

            using (var proc = Process.Start(psi))
            {
                proc.WaitForExit();
                if (proc.ExitCode != 0)
                {
                    Console.WriteLine();
                    Console.WriteLine("  Setup failed with exit code " + proc.ExitCode + ".");
                }
                Pause();
                return proc.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("  Setup failed: " + ex.Message);
            Pause();
            return 1;
        }
        finally
        {
            try { if (Directory.Exists(work)) Directory.Delete(work, true); } catch { }
        }
    }

    static void Extract(string work)
    {
        var assembly = Assembly.GetExecutingAssembly();
        using (Stream stream = assembly.GetManifestResourceStream(PayloadResource))
        {
            if (stream == null) throw new InvalidOperationException("embedded payload is missing");
            string zip = Path.Combine(work, PayloadResource);
            using (var file = File.Create(zip)) stream.CopyTo(file);
            ZipFile.ExtractToDirectory(zip, work);
            File.Delete(zip);
        }
    }

    static void Pause()
    {
        // เปิดจาก File Explorer แล้วหน้าต่างจะปิดทันทีถ้าไม่หยุดรอ ทำให้อ่านผลไม่ทัน
        if (Console.IsInputRedirected) return;
        Console.WriteLine();
        Console.Write("  Press any key to close...");
        try { Console.ReadKey(true); } catch { }
        Console.WriteLine();
    }
}
