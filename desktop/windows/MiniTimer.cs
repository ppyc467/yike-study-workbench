using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (Array.IndexOf(args, "--self-test") >= 0) return SelfTests.Run();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Native.SetProcessDPIAware();
        int qaProcessId = 0;
        int qaOption = Array.IndexOf(args, "--qa-main-pid");
        if (qaOption >= 0 && (qaOption + 1 >= args.Length || !int.TryParse(args[qaOption + 1], out qaProcessId))) return 2;
        bool watchOnly = Array.IndexOf(args, "--watch-only") >= 0 || qaProcessId != 0;
        try
        {
            string configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.json");
            LauncherConfig config = new JavaScriptSerializer().Deserialize<LauncherConfig>(File.ReadAllText(configPath));
            if (!watchOnly)
            {
                Process.Start(new ProcessStartInfo(config.executable, config.arguments) { UseShellExecute = true });
            }
            bool firstInstance;
            string mutexName = @"Local\YikeDesktopMiniTimer-v1" + (qaProcessId == 0 ? "" : "-qa-" + qaProcessId);
            using (Mutex mutex = new Mutex(true, mutexName, out firstInstance))
            {
                if (!firstInstance) return 0;
                Application.Run(new MiniTimerContext(config.appId, qaProcessId, watchOnly));
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show("一刻小窗启动失败。\n" + error.Message, "一刻", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
    }
}

public sealed class LauncherConfig
{
    public string executable { get; set; }
    public string arguments { get; set; }
    public string appId { get; set; }
}

internal sealed class TimerSnapshot
{
    private static readonly Regex Prefix = new Regex(@"^(专注中|已暂停|专注完成) (\d{2,}):(\d{2}):(\d{2}) · ", RegexOptions.CultureInvariant);
    public string Status;
    public string Task;
    public bool Countdown;
    public long Seconds;

    public bool Running { get { return Status == "专注中"; } }

    public static TimerSnapshot Parse(string title)
    {
        if (title.StartsWith("一刻 · 学习工作台", StringComparison.Ordinal))
            return new TimerSnapshot { Status = "尚未开始", Task = "一刻 · 学习工作台" };
        Match match = Prefix.Match(title);
        if (!match.Success) return null;
        long hours;
        if (!long.TryParse(match.Groups[2].Value, out hours) || hours > 100000) return null;
        int minutes = int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
        int seconds = int.Parse(match.Groups[4].Value, CultureInfo.InvariantCulture);
        if (minutes >= 60 || seconds >= 60) return null;
        string body = title.Substring(match.Length);
        string task = "当前学习任务";
        bool countdown = false;
        if (body.StartsWith("自由计时 · ", StringComparison.Ordinal) || body.StartsWith("番茄专注 · ", StringComparison.Ordinal))
        {
            int taskEnd = body.LastIndexOf(" · 一刻", StringComparison.Ordinal);
            if (taskEnd < 7) return null;
            countdown = body.StartsWith("番茄专注", StringComparison.Ordinal);
            task = body.Substring(7, taskEnd - 7);
        }
        else if (body != "一刻" && !body.StartsWith("一刻 - ", StringComparison.Ordinal) && !body.StartsWith("一刻 — ", StringComparison.Ordinal)) return null;
        return new TimerSnapshot
        {
            Status = match.Groups[1].Value,
            Seconds = hours * 3600 + minutes * 60 + seconds,
            Countdown = countdown,
            Task = string.IsNullOrWhiteSpace(task) ? "当前学习任务" : task
        };
    }

    public long At(double elapsedSeconds)
    {
        long drift = Running ? (long)Math.Floor(Math.Max(0, elapsedSeconds)) : 0;
        return Math.Max(0, Seconds + (Countdown ? -drift : drift));
    }

    public static string Clock(long seconds)
    {
        seconds = Math.Max(0, seconds);
        return string.Format(CultureInfo.InvariantCulture, "{0:00}:{1:00}:{2:00}", seconds / 3600, seconds / 60 % 60, seconds % 60);
    }
}

internal sealed class MiniTimerContext : ApplicationContext
{
    private readonly string appId;
    private readonly int qaProcessId;
    private readonly bool watchOnly;
    private readonly MiniTimerForm popup = new MiniTimerForm();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private readonly Stopwatch lifetime = Stopwatch.StartNew();
    private readonly Stopwatch sampleAge = Stopwatch.StartNew();
    private IntPtr mainWindow;
    private uint mainProcessId;
    private AutomationElement browserRoot;
    private bool hasPageTitle;
    private long nextTitleRead;
    private bool hasSeenMain;
    private bool minimized;
    private bool dismissed;
    private long missingSince;
    private string previousTitle;
    private TimerSnapshot sample;

    public MiniTimerContext(string configuredAppId, int testProcessId, bool monitoringOnly)
    {
        appId = configuredAppId;
        qaProcessId = testProcessId;
        watchOnly = monitoringOnly;
        popup.ReturnRequested += delegate { RestoreMain(); };
        popup.DismissRequested += delegate { dismissed = true; popup.Hide(); };
        timer.Interval = 250;
        timer.Tick += delegate { Poll(); };
        timer.Start();
    }

    private void Poll()
    {
        uint ownerProcessId;
        Native.GetWindowThreadProcessId(mainWindow, out ownerProcessId);
        if (mainWindow == IntPtr.Zero || !Native.IsWindow(mainWindow) || ownerProcessId != mainProcessId)
        {
            mainWindow = FindMainWindow();
            Native.GetWindowThreadProcessId(mainWindow, out mainProcessId);
            browserRoot = null;
            hasPageTitle = false;
            nextTitleRead = 0;
            previousTitle = null;
            sample = null;
            minimized = false;
            dismissed = false;
        }
        if (mainWindow == IntPtr.Zero)
        {
            popup.Hide();
            if (hasSeenMain)
            {
                if (missingSince == 0) missingSince = lifetime.ElapsedMilliseconds;
                if (lifetime.ElapsedMilliseconds - missingSince >= 2500) ExitThread();
            }
            else if (lifetime.Elapsed.TotalSeconds >= 60)
            {
                if (!watchOnly) MessageBox.Show("没有找到一刻主窗口。请重新打开桌面的「一刻 · 学习工作台」。", "一刻", MessageBoxButtons.OK, MessageBoxIcon.Information);
                ExitThread();
            }
            return;
        }
        hasSeenMain = true;
        missingSince = 0;
        if (lifetime.ElapsedMilliseconds >= nextTitleRead)
        {
            nextTitleRead = lifetime.ElapsedMilliseconds + 1000;
            string title = ReadTimerTitle();
            if (title != null && title != previousTitle)
            {
                TimerSnapshot next = TimerSnapshot.Parse(title);
                if (next != null)
                {
                    sample = next;
                    previousTitle = title;
                    sampleAge.Restart();
                }
            }
        }
        bool nowMinimized = Native.IsIconic(mainWindow);
        if (!nowMinimized)
        {
            dismissed = false;
            popup.Hide();
        }
        else if (!dismissed)
        {
            TimerSnapshot current = sample ?? new TimerSnapshot { Status = "正在打开", Task = "一刻 · 学习工作台" };
            long seconds = current.At(sampleAge.Elapsed.TotalSeconds);
            string status = current.Countdown && current.Running && seconds == 0 ? "专注完成" : current.Status;
            popup.UpdateTimer(current.Task, TimerSnapshot.Clock(seconds), status, current.Countdown);
            if (!popup.Visible)
            {
                if (!minimized) popup.EnsureOnScreen();
                popup.Show();
                Native.SetWindowPos(popup.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040);
            }
        }
        minimized = nowMinimized;
    }

    private string ReadTimerTitle()
    {
        // Installed Edge apps keep a fixed frame title. BrowserRootView exposes the live page title.
        try
        {
            if (browserRoot == null)
            {
                browserRoot = AutomationElement.FromHandle(mainWindow).FindFirst(TreeScope.Children,
                    new PropertyCondition(AutomationElement.ClassNameProperty, "BrowserRootView"));
            }
            if (browserRoot != null)
            {
                string title = browserRoot.Current.Name;
                if (TimerSnapshot.Parse(title) != null)
                {
                    hasPageTitle = true;
                    return title;
                }
                browserRoot = null;
            }
        }
        catch (ElementNotAvailableException) { browserRoot = null; }
        catch (COMException) { browserRoot = null; }
        catch (InvalidOperationException) { browserRoot = null; }

        string frameTitle = Native.WindowTitle(mainWindow);
        // Retain the last live sample during a transient accessibility failure and retry next second.
        if (hasPageTitle && frameTitle.StartsWith("一刻 · 学习工作台", StringComparison.Ordinal)) return null;
        return frameTitle;
    }

    private IntPtr FindMainWindow()
    {
        IntPtr found = IntPtr.Zero;
        IntPtr titleFallback = IntPtr.Zero;
        Native.EnumWindows(delegate(IntPtr handle, IntPtr unused)
        {
            if (!Native.IsWindowVisible(handle) || handle == popup.Handle) return true;
            uint processId;
            Native.GetWindowThreadProcessId(handle, out processId);
            if (qaProcessId != 0)
            {
                if (processId != qaProcessId) return true;
            }
            else
            {
                try
                {
                    using (Process process = Process.GetProcessById((int)processId))
                        if (!string.Equals(process.ProcessName, "msedge", StringComparison.OrdinalIgnoreCase)) return true;
                }
                catch (ArgumentException) { return true; }
                catch (InvalidOperationException) { return true; }
            }
            if (TimerSnapshot.Parse(Native.WindowTitle(handle)) == null) return true;
            if (qaProcessId != 0 || Native.AppUserModelId(handle).IndexOf(appId, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                found = handle;
                return false;
            }
            if (titleFallback == IntPtr.Zero) titleFallback = handle;
            return true;
        }, IntPtr.Zero);
        return found != IntPtr.Zero ? found : titleFallback;
    }

    private void RestoreMain()
    {
        if (mainWindow == IntPtr.Zero || !Native.IsWindow(mainWindow)) return;
        Native.ShowWindowAsync(mainWindow, 9);
        Native.SetForegroundWindow(mainWindow);
        popup.Hide();
    }

    protected override void ExitThreadCore()
    {
        timer.Stop();
        timer.Dispose();
        popup.Close();
        popup.Dispose();
        base.ExitThreadCore();
    }
}

internal sealed class MiniTimerForm : Form
{
    private static readonly Color Green = Color.FromArgb(82, 113, 89);
    private readonly Label task = new Label();
    private readonly Label clock = new Label();
    private readonly Label status = new Label();
    private readonly ToolTip tips = new ToolTip();
    private readonly string positionPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YikeMiniTimer", "position.txt");
    public event EventHandler ReturnRequested;
    public event EventHandler DismissRequested;

    public MiniTimerForm()
    {
        SuspendLayout();
        Text = "一刻计时小窗";
        AccessibleName = "一刻计时小窗";
        Font = new Font("Microsoft YaHei UI", 9F);
        BackColor = Color.FromArgb(250, 251, 246);
        ForeColor = Color.FromArgb(47, 61, 49);
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(310, 142);
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        DoubleBuffered = true;

        task.SetBounds(18, 13, 244, 22);
        task.AutoEllipsis = true;
        task.Font = new Font(Font, FontStyle.Bold);
        task.TextAlign = ContentAlignment.MiddleLeft;
        task.AccessibleName = "当前学习任务";
        clock.SetBounds(14, 39, 284, 49);
        clock.Font = new Font("Consolas", 30F, FontStyle.Regular);
        clock.ForeColor = Green;
        clock.AccessibleName = "当前计时";
        status.Font = new Font(Font, FontStyle.Regular);
        status.SetBounds(18, 105, 148, 22);
        status.ForeColor = Color.FromArgb(113, 124, 111);
        status.AccessibleName = "专注状态";
        Button close = MakeButton("×", "暂时收起计时小窗", new Rectangle(271, 9, 28, 27));
        close.Font = new Font("Segoe UI", 15F);
        close.ForeColor = Color.FromArgb(124, 132, 121);
        close.Click += delegate { if (DismissRequested != null) DismissRequested(this, EventArgs.Empty); };
        Button restore = MakeButton("返回主界面 ↗", "返回一刻主界面", new Rectangle(183, 101, 111, 29));
        restore.BackColor = Color.FromArgb(230, 237, 225);
        restore.ForeColor = Green;
        restore.Click += delegate { if (ReturnRequested != null) ReturnRequested(this, EventArgs.Empty); };
        Controls.AddRange(new Control[] { task, clock, status, close, restore });
        foreach (Control control in new Control[] { this, task, clock, status }) control.MouseDown += DragWindow;
        MouseUp += delegate { SavePosition(); };
        DoubleClick += delegate { if (ReturnRequested != null) ReturnRequested(this, EventArgs.Empty); };
        tips.SetToolTip(close, "本次收起，主窗口再次最小化时重新显示");
        tips.SetToolTip(restore, "打开完整计时器和学习任务");
        ResumeLayout(false);
        PerformAutoScale();
        LoadPosition();
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams parameters = base.CreateParams;
            parameters.ExStyle |= 0x00000080 | 0x08000000;
            parameters.ClassStyle |= 0x00020000;
            return parameters;
        }
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0021)
        {
            message.Result = new IntPtr(3);
            return;
        }
        base.WndProc(ref message);
    }

    private Button MakeButton(string text, string name, Rectangle bounds)
    {
        Button button = new Button { Text = text, AccessibleName = name, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand, TabStop = true };
        button.Bounds = bounds;
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(224, 233, 218);
        button.FlatAppearance.MouseDownBackColor = Color.FromArgb(211, 224, 206);
        return button;
    }

    public void UpdateTimer(string taskTitle, string time, string state, bool countdown)
    {
        if (task.Text != taskTitle) { task.Text = taskTitle; tips.SetToolTip(task, taskTitle); }
        clock.Text = time;
        status.Text = state + (state == "尚未开始" || state == "正在打开" ? "" : " · " + (countdown ? "番茄专注" : "自由计时"));
    }

    private void DragWindow(object sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        Native.ReleaseCapture();
        Native.SendMessage(Handle, 0x00A1, new IntPtr(2), IntPtr.Zero);
        EnsureOnScreen();
        SavePosition();
    }

    public void EnsureOnScreen()
    {
        Rectangle workArea = Screen.FromRectangle(Bounds).WorkingArea;
        Location = ClampLocation(Location, Size, workArea);
    }

    internal static Point ClampLocation(Point location, Size size, Rectangle area)
    {
        int maximumX = Math.Max(area.Left, area.Right - size.Width);
        int maximumY = Math.Max(area.Top, area.Bottom - size.Height);
        return new Point(Math.Min(maximumX, Math.Max(area.Left, location.X)), Math.Min(maximumY, Math.Max(area.Top, location.Y)));
    }

    private void LoadPosition()
    {
        Rectangle workArea = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(workArea.Right - Width - 28, workArea.Top + 36);
        try
        {
            string[] saved = File.ReadAllText(positionPath).Split(',');
            int x, y;
            if (saved.Length == 2 && int.TryParse(saved[0], out x) && int.TryParse(saved[1], out y)) Location = new Point(x, y);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        EnsureOnScreen();
    }

    private void SavePosition()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(positionPath));
            File.WriteAllText(positionPath, Location.X + "," + Location.Y);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (GraphicsPath outline = RoundedRectangle(new Rectangle(0, 0, Width - 1, Height - 1), 15))
        using (Pen border = new Pen(Color.FromArgb(214, 225, 208)))
            e.Graphics.DrawPath(border, outline);
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        if (Width < 2 || Height < 2) return;
        using (GraphicsPath outline = RoundedRectangle(new Rectangle(0, 0, Width, Height), 15))
        {
            Region old = Region;
            Region = new Region(outline);
            if (old != null) old.Dispose();
        }
    }

    private static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
    {
        int diameter = radius * 2;
        GraphicsPath path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) tips.Dispose();
        base.Dispose(disposing);
    }
}

internal static class Native
{
    public delegate bool EnumWindowCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder buffer, int maximum);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("shell32.dll")] private static extern int SHGetPropertyStoreForWindow(IntPtr handle, ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);

    public static string WindowTitle(IntPtr handle)
    {
        StringBuilder buffer = new StringBuilder(4096);
        GetWindowText(handle, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    public static string AppUserModelId(IntPtr handle)
    {
        Guid interfaceId = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        if (SHGetPropertyStoreForWindow(handle, ref interfaceId, out store) != 0) return "";
        try
        {
            PropertyKey key = new PropertyKey { FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), PropertyId = 5 };
            PropVariant value;
            if (store.GetValue(ref key, out value) != 0) return "";
            try { return value.Type == 31 && value.Pointer != IntPtr.Zero ? Marshal.PtrToStringUni(value.Pointer) : ""; }
            finally { PropVariantClear(ref value); }
        }
        finally { Marshal.ReleaseComObject(store); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct PropertyKey { public Guid FormatId; public uint PropertyId; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] private struct PropVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Pointer;
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }
}

internal static class SelfTests
{
    private static int assertions;
    private static void Check(bool condition, string name)
    {
        assertions++;
        if (!condition) throw new InvalidOperationException(name);
    }

    public static int Run()
    {
        try
        {
            TimerSnapshot free = TimerSnapshot.Parse("专注中 00:01:02 · 自由计时 · 数据结构 · 一刻");
            Check(free != null && free.Task == "数据结构" && free.Seconds == 62 && !free.Countdown, "free title");
            Check(free.At(4.9) == 66, "free interpolation");
            Check(free.At(-10) == 62, "negative sample age");
            TimerSnapshot countdown = TimerSnapshot.Parse("专注中 00:24:59 · 番茄专注 · 英语 · 一刻 - 一刻 · 学习工作台");
            Check(countdown.Countdown && countdown.Task == "英语", "countdown title and browser suffix");
            Check(countdown.At(9.5) == 1490, "countdown interpolation");
            Check(countdown.At(2000) == 0, "countdown clamp");
            TimerSnapshot pause = TimerSnapshot.Parse("已暂停 01:02:03 · 番茄专注 · 大作业 · 一刻");
            Check(pause.At(200) == 3723 && !pause.Running, "pause freezes");
            TimerSnapshot complete = TimerSnapshot.Parse("专注完成 00:00:00 · 番茄专注 · 阅读 · 一刻");
            Check(complete.At(200) == 0 && !complete.Running, "completed freezes");
            Check(TimerSnapshot.Parse("一刻 · 学习工作台 - Microsoft Edge").Status == "尚未开始", "idle title");
            Check(TimerSnapshot.Parse("专注中 00:00:10 · 一刻").At(5) == 15, "legacy title");
            Check(TimerSnapshot.Parse("专注中 00:00:10 · 一刻 - Microsoft Edge") != null, "legacy browser suffix");
            Check(TimerSnapshot.Parse("专注中 00:60:10 · 一刻") == null, "invalid minute");
            Check(TimerSnapshot.Parse("专注中 00:10:60 · 一刻") == null, "invalid second");
            Check(TimerSnapshot.Parse("Some other app") == null, "other window");
            Check(TimerSnapshot.Parse("专注中 00:10:10 · 其他应用") == null, "unrelated timer");
            Check(TimerSnapshot.Parse("专注中 00:10:10 · 自由计时 · 一刻") == null, "malformed task title");
            Check(TimerSnapshot.Parse("专注中 00:10:10 · 自由计时 · 笔记 · 一刻 · 复习 · 一刻").Task == "笔记 · 一刻 · 复习", "task with separator and brand");
            Check(TimerSnapshot.Clock(360000) == "100:00:00", "long timer");
            Check(TimerSnapshot.Clock(-1) == "00:00:00", "negative display clamp");
            Check(MiniTimerForm.ClampLocation(new Point(-100, 900), new Size(310, 142), new Rectangle(0, 0, 1920, 1040)) == new Point(0, 898), "window clamp");
            Check(MiniTimerForm.ClampLocation(new Point(-1500, 30), new Size(310, 142), new Rectangle(-1920, 0, 1920, 1080)) == new Point(-1500, 30), "negative monitor coordinates");
            File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "self-test-result.txt"), "PASS " + assertions + " assertions" + Environment.NewLine);
            return 0;
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "self-test-result.txt"), "FAIL " + error + Environment.NewLine);
            return 1;
        }
    }
}
