// Yalnız bir sürecin (ve alt süreçlerinin) sesini yakalar: Windows 10 2004+ "process loopback".
// Canlı yayında tüm bilgisayar sesi (bildirim, Discord, tarayıcı…) yerine yalnız mpv'nin sesi gitsin.
// Kullanım: uygulama-sesi.exe <pid>   -> stdout'a ham PCM: 48000 Hz, 2 kanal, 16 bit (little-endian).
// İlk kullanımda Windows'un kendi C# derleyicisiyle (.NET Framework csc.exe) derleniyor (bkz. uygulama-sesi.cjs).
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class UygulamaSesi
{
    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX { public ushort wFormatTag, nChannels; public uint nSamplesPerSec, nAvgBytesPerSec; public ushort nBlockAlign, wBitsPerSample, cbSize; }

    [StructLayout(LayoutKind.Sequential)]
    struct ACTIVATION_PARAMS { public int ActivationType; public uint TargetProcessId; public int ProcessLoopbackMode; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT_BLOB { public ushort vt; public ushort r1, r2, r3; public uint cbSize; public IntPtr pBlobData; }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, ref WAVEFORMATEX format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long def, out long min);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op);
    }

    // IAgileObject: Windows tamamlama nesnesinin herhangi bir iş parçacığından çağrılabilmesini istiyor.
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    class Tamamlandi : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Bitti = new ManualResetEvent(false);
        public IActivateAudioInterfaceAsyncOperation Islem;
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) { Islem = op; Bitti.Set(); }
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, [MarshalAs(UnmanagedType.LPStruct)] Guid iid,
        IntPtr activationParams, IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);

    [DllImport("kernel32.dll")] static extern IntPtr CreateEvent(IntPtr a, bool manual, bool initial, string name);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);

    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const uint LOOPBACK = 0x00020000, EVENTCALLBACK = 0x00040000, AUTOCONVERTPCM = 0x80000000, SRC_DEFAULT_QUALITY = 0x08000000;
    const uint SILENT = 0x2;

    [MTAThread]
    static int Main(string[] args)
    {
        uint pid;
        if (args.Length < 1 || !uint.TryParse(args[0], out pid)) { Console.Error.WriteLine("kullanim: uygulama-sesi.exe <pid>"); return 2; }
        try { return Calistir(pid); }
        catch (Exception e) { Console.Error.WriteLine("HATA " + e.Message); return 1; }
    }

    static int Calistir(uint pid)
    {
        var p = new ACTIVATION_PARAMS { ActivationType = 1 /* PROCESS_LOOPBACK */, TargetProcessId = pid, ProcessLoopbackMode = 0 /* INCLUDE_TARGET_PROCESS_TREE */ };
        IntPtr pParams = Marshal.AllocHGlobal(Marshal.SizeOf(p));
        Marshal.StructureToPtr(p, pParams, false);
        var blob = new PROPVARIANT_BLOB { vt = 65 /* VT_BLOB */, cbSize = (uint)Marshal.SizeOf(p), pBlobData = pParams };
        IntPtr pBlob = Marshal.AllocHGlobal(Marshal.SizeOf(blob));
        Marshal.StructureToPtr(blob, pBlob, false);

        var tamam = new Tamamlandi();
        IActivateAudioInterfaceAsyncOperation islem;
        ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IAudioClient).GUID, pBlob, tamam, out islem);
        if (!tamam.Bitti.WaitOne(5000)) { Console.Error.WriteLine("HATA etkinlestirme zaman asimi"); return 1; }
        int hr; object nesne;
        tamam.Islem.GetActivateResult(out hr, out nesne);
        if (hr != 0) { Console.Error.WriteLine("HATA etkinlestirme 0x" + hr.ToString("X8")); return 1; }
        var istemci = (IAudioClient)nesne;

        var bicim = new WAVEFORMATEX { wFormatTag = 1, nChannels = 2, nSamplesPerSec = 48000, wBitsPerSample = 16, nBlockAlign = 4, nAvgBytesPerSec = 48000 * 4, cbSize = 0 };
        hr = istemci.Initialize(AUDCLNT_SHAREMODE_SHARED, LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY, 200000 /* 20 ms */, 0, ref bicim, IntPtr.Zero);
        if (hr != 0) { Console.Error.WriteLine("HATA Initialize 0x" + hr.ToString("X8")); return 1; }
        IntPtr olay = CreateEvent(IntPtr.Zero, false, false, null);
        istemci.SetEventHandle(olay);
        object hizmet;
        hr = istemci.GetService(typeof(IAudioCaptureClient).GUID, out hizmet);
        if (hr != 0) { Console.Error.WriteLine("HATA GetService 0x" + hr.ToString("X8")); return 1; }
        var yakalayici = (IAudioCaptureClient)hizmet;
        hr = istemci.Start();
        if (hr != 0) { Console.Error.WriteLine("HATA Start 0x" + hr.ToString("X8")); return 1; }
        Console.Error.WriteLine("BASLADI");

        Stream cikti = Console.OpenStandardOutput();
        byte[] tampon = new byte[48000 * 4];
        while (true)
        {
            WaitForSingleObject(olay, 100);
            uint paket;
            while (yakalayici.GetNextPacketSize(out paket) == 0 && paket > 0)
            {
                IntPtr veri; uint kare, bayrak; ulong a, b;
                if (yakalayici.GetBuffer(out veri, out kare, out bayrak, out a, out b) != 0) break;
                int bayt = (int)kare * 4;
                if (bayt > tampon.Length) tampon = new byte[bayt];
                if ((bayrak & SILENT) != 0) Array.Clear(tampon, 0, bayt);
                else Marshal.Copy(veri, tampon, 0, bayt);
                yakalayici.ReleaseBuffer(kare);
                try { cikti.Write(tampon, 0, bayt); cikti.Flush(); }
                catch (IOException) { return 0; } // okuyan kapandı
            }
        }
    }
}
