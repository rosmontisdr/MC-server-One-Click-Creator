# mcsp 图形启动器（WPF 原生窗口，不走浏览器、不装任何东西）
#
# 界面按 mcpanel 的同一套设计变量做：配色、圆角、字号、间距都照抄，
# color-mix() 那几处预先算成字面量（WPF 用 #AARRGGBB，百分比透明度直接可写）。
#
# 本文件必须存为「UTF-8 带 BOM」。PowerShell 5.1 读无 BOM 的 .ps1 会按系统 ANSI 解码，
# 中文全部变乱码；Node 侧用 fs.writeFileSync 加 '﻿' 写出即可。
#
# 判定与打包不在这里实现：本脚本只负责界面，干活的是同目录的 mcsp.js，
# 通过它的 --json 事件流（NDJSON）拿进度，退出码 0/3 表示成功、1 表示失败。

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Script:Job = $null   # 当前任务：{ Job（C# 侧的子进程句柄）, Out, Input, Mode, Finished }
$Script:LastInput = ''
$Script:LastKind = ''

# 单实例：双击两次不该开出两个窗口
$Script:Mutex = New-Object System.Threading.Mutex($false, 'Local\mcsp-gui')
if (-not $Script:Mutex.WaitOne(0)) {
  [System.Windows.Forms.MessageBox]::Show('mcsp 启动器已经在运行了。', 'mcsp')
  exit 0
}

# ── 配色（与 mcpanel/public/style.css 的 :root[data-theme="dark"] 一致）──────

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="mcsp 启动器 — 整合包转服务端" Height="880" Width="940" MinHeight="640" MinWidth="820"
        Background="#0d0d0d" Foreground="#ffffff"
        FontFamily="Microsoft YaHei UI" FontSize="13"
        WindowStartupLocation="CenterScreen" AllowDrop="True"
        UseLayoutRounding="True" TextOptions.TextFormattingMode="Display">
  <Window.Resources>

    <!-- 按钮：同一套模板，颜色与悬停由各自的样式给 -->
    <ControlTemplate x:Key="BtnTpl" TargetType="Button">
      <Border x:Name="bd" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
              BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="8" SnapsToDevicePixels="True">
        <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"
                          Margin="{TemplateBinding Padding}"/>
      </Border>
    </ControlTemplate>

    <Style x:Key="Btn" TargetType="Button">
      <Setter Property="Foreground" Value="#ffffff"/>
      <Setter Property="Background" Value="#212120"/>
      <Setter Property="BorderBrush" Value="#2c2c2a"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="13,7"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template" Value="{StaticResource BtnTpl}"/>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Background" Value="#2a2a28"/>
        </Trigger>
        <Trigger Property="IsEnabled" Value="False">
          <Setter Property="Opacity" Value="0.42"/>
          <Setter Property="Cursor" Value="Arrow"/>
        </Trigger>
      </Style.Triggers>
    </Style>

    <Style x:Key="BtnPrimary" TargetType="Button">
      <Setter Property="Foreground" Value="#04150f"/>
      <Setter Property="Background" Value="#1baf7a"/>
      <Setter Property="BorderBrush" Value="Transparent"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="16,9"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template" Value="{StaticResource BtnTpl}"/>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Background" Value="#3bba8c"/>
        </Trigger>
        <Trigger Property="IsEnabled" Value="False">
          <Setter Property="Opacity" Value="0.42"/>
          <Setter Property="Cursor" Value="Arrow"/>
        </Trigger>
      </Style.Triggers>
    </Style>

    <Style x:Key="BtnGhost" TargetType="Button">
      <Setter Property="Foreground" Value="#c3c2b7"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="BorderBrush" Value="Transparent"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="10,7"/>
      <Setter Property="FontSize" Value="12.5"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template" Value="{StaticResource BtnTpl}"/>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Background" Value="#212120"/>
          <Setter Property="Foreground" Value="#ffffff"/>
        </Trigger>
      </Style.Triggers>
    </Style>

    <Style x:Key="Card" TargetType="Border">
      <Setter Property="Background" Value="#1a1a19"/>
      <Setter Property="BorderBrush" Value="#2c2c2a"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="CornerRadius" Value="12"/>
      <Setter Property="Padding" Value="16"/>
      <Setter Property="Margin" Value="0,0,0,14"/>
      <Setter Property="Effect">
        <Setter.Value>
          <DropShadowEffect BlurRadius="24" ShadowDepth="0" Opacity="0.30" Color="#000000"/>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- 进度的轨道与填充：对应面板 .meter 的 22% 底色 + 实色填充 -->
    <Style x:Key="PBar" TargetType="ProgressBar">
      <Setter Property="Height" Value="8"/>
      <Setter Property="Maximum" Value="100"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ProgressBar">
            <Grid>
              <Border Name="PART_Track" Background="#331baf7a" CornerRadius="4"/>
              <Border Name="PART_Indicator" Background="#1baf7a" CornerRadius="4" HorizontalAlignment="Left"/>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="Ink1" TargetType="TextBlock">
      <Setter Property="Foreground" Value="#ffffff"/>
    </Style>
    <Style x:Key="Ink2" TargetType="TextBlock">
      <Setter Property="Foreground" Value="#c3c2b7"/>
    </Style>
    <Style x:Key="Ink3" TargetType="TextBlock">
      <Setter Property="Foreground" Value="#898781"/>
      <Setter Property="FontSize" Value="11.5"/>
    </Style>
    <Style x:Key="CardTitle" TargetType="TextBlock">
      <Setter Property="Foreground" Value="#ffffff"/>
      <Setter Property="FontSize" Value="13.5"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
    </Style>
    <Style x:Key="Label" TargetType="TextBlock">
      <Setter Property="Foreground" Value="#898781"/>
      <Setter Property="FontSize" Value="11"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Margin" Value="0,0,0,8"/>
    </Style>

    <Style x:Key="Mono" TargetType="TextBox">
      <Setter Property="Background" Value="#0d0d0d"/>
      <Setter Property="Foreground" Value="#c3c2b7"/>
      <Setter Property="BorderBrush" Value="#2c2c2a"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="FontFamily" Value="Cascadia Mono, Consolas, monospace"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Padding" Value="10,8"/>
      <Setter Property="IsReadOnly" Value="True"/>
      <Setter Property="TextWrapping" Value="NoWrap"/>
      <Setter Property="VerticalScrollBarVisibility" Value="Auto"/>
      <Setter Property="HorizontalScrollBarVisibility" Value="Auto"/>
    </Style>

    <Style x:Key="PathBox" TargetType="TextBox">
      <Setter Property="Background" Value="#0d0d0d"/>
      <Setter Property="Foreground" Value="#ffffff"/>
      <Setter Property="BorderBrush" Value="#2c2c2a"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="FontFamily" Value="Cascadia Mono, Consolas, monospace"/>
      <Setter Property="FontSize" Value="12.5"/>
      <Setter Property="Padding" Value="9,8"/>
      <Setter Property="IsReadOnly" Value="True"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="TextBox">
            <Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="8">
              <ScrollViewer x:Name="PART_ContentHost" Margin="{TemplateBinding Padding}" VerticalAlignment="Center"/>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="Item" TargetType="ListBoxItem">
      <Setter Property="Padding" Value="8,5"/>
      <Setter Property="Foreground" Value="#c3c2b7"/>
      <Setter Property="FontSize" Value="12.5"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ListBoxItem">
            <Border x:Name="bd" Background="Transparent" CornerRadius="6" Padding="{TemplateBinding Padding}">
              <ContentPresenter/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#212120"/>
              </Trigger>
              <Trigger Property="IsSelected" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#2a2a28"/>
                <Setter Property="Foreground" Value="#ffffff"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- 模式选择：两张可点卡片，选中时描边变强调色并加一个圆点 -->
    <ControlTemplate x:Key="ModeTpl" TargetType="RadioButton">
      <Border x:Name="bd" Background="#212120" BorderBrush="#2c2c2a" BorderThickness="2"
              CornerRadius="10" Padding="14,12">
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="*"/>
          </Grid.ColumnDefinitions>
          <Border x:Name="dot" Grid.Column="0" Width="14" Height="14" CornerRadius="7"
                  BorderBrush="#898781" BorderThickness="2" VerticalAlignment="Top" Margin="0,2,11,0"/>
          <ContentPresenter Grid.Column="1"/>
        </Grid>
      </Border>
      <ControlTemplate.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter TargetName="bd" Property="Background" Value="#2a2a28"/>
        </Trigger>
        <Trigger Property="IsChecked" Value="True">
          <Setter TargetName="bd" Property="BorderBrush" Value="#1baf7a"/>
          <Setter TargetName="bd" Property="Background" Value="#17211d"/>
          <Setter TargetName="dot" Property="BorderBrush" Value="#1baf7a"/>
          <Setter TargetName="dot" Property="Background" Value="#1baf7a"/>
        </Trigger>
      </ControlTemplate.Triggers>
    </ControlTemplate>

    <Style x:Key="Mode" TargetType="RadioButton">
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Foreground" Value="#ffffff"/>
      <Setter Property="Template" Value="{StaticResource ModeTpl}"/>
    </Style>

    <!-- 滚动条跟着深色走，否则系统默认的浅灰在暗色卡片里很扎眼 -->
    <Style x:Key="Thumb" TargetType="Thumb">
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Thumb">
            <Border Background="#2a2a28" CornerRadius="5" Margin="2,0,2,0"/>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="ScrollBar">
      <Setter Property="Width" Value="11"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Grid Background="Transparent">
              <Track x:Name="PART_Track" IsDirectionReversed="True">
                <Track.Thumb><Thumb Style="{StaticResource Thumb}"/></Track.Thumb>
                <Track.IncreaseRepeatButton>
                  <RepeatButton Command="ScrollBar.PageDownCommand" Opacity="0" Focusable="False"/>
                </Track.IncreaseRepeatButton>
                <Track.DecreaseRepeatButton>
                  <RepeatButton Command="ScrollBar.PageUpCommand" Opacity="0" Focusable="False"/>
                </Track.DecreaseRepeatButton>
              </Track>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>

  <Grid Margin="22,20,22,18">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <!-- 顶栏：与面板 .brand 同构（色块 + 标题 + 副标题 + 署名） -->
    <Grid Grid.Row="0" Margin="0,0,0,18">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="Auto"/>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>
      <Border Grid.Column="0" Width="32" Height="32" CornerRadius="7" Background="#1baf7a" Margin="0,0,11,0" VerticalAlignment="Top">
        <StackPanel Margin="7,9,7,7">
          <Border Height="5" CornerRadius="1.5" Background="#ffffff" Opacity="0.92"/>
          <Border Height="6" CornerRadius="1.5" Background="#ffffff" Opacity="0.5" Width="11" HorizontalAlignment="Left" Margin="0,3,0,0"/>
        </StackPanel>
      </Border>
      <StackPanel Grid.Column="1">
        <TextBlock Text="客户端一键制作工具" FontSize="17" FontWeight="SemiBold"/>
        <TextBlock Text="by 玄渊不是香厨（bilibili）" FontSize="11.5" Foreground="#898781"/>
      </StackPanel>
      <StackPanel Grid.Column="2" HorizontalAlignment="Right" VerticalAlignment="Top">
        <TextBlock x:Name="StatusText" Text="等待选择整合包" FontSize="12" Foreground="#898781" HorizontalAlignment="Right"/>
        <TextBlock x:Name="VersionText" Text="" FontSize="10.5" Foreground="#898781" HorizontalAlignment="Right" Margin="0,3,0,0"/>
      </StackPanel>
    </Grid>

    <ScrollViewer x:Name="Scroller" Grid.Row="1" VerticalScrollBarVisibility="Auto" Padding="0,0,4,0">
      <StackPanel>

        <!-- ① 整合包 -->
        <Border Style="{StaticResource Card}">
          <StackPanel>
            <TextBlock Text="整合包" Style="{StaticResource CardTitle}"/>
            <TextBlock Text="客户端实例目录、客户端整合包 zip、Modrinth .mrpack 都可以。"
                       Style="{StaticResource Ink3}" Margin="0,3,0,12"/>

            <Grid Margin="0,0,0,12">
              <!-- 虚线环用 Rectangle 画：Border 没有虚线描边 -->
              <Rectangle x:Name="DropRing" RadiusX="10" RadiusY="10" Stroke="#3a3a37" StrokeThickness="1"
                         StrokeDashArray="4 3" Fill="#0d0d0d"/>
              <StackPanel Margin="18,22,18,22" HorizontalAlignment="Center" VerticalAlignment="Center">
                <TextBlock x:Name="DropTitle" Text="把整合包拖到这里" FontSize="13.5" FontWeight="SemiBold"
                           HorizontalAlignment="Center" Foreground="#c3c2b7"/>
                <TextBlock x:Name="DropSub" Text="文件夹或 zip 都行"
                           Style="{StaticResource Ink3}" HorizontalAlignment="Center" Margin="0,4,0,0"/>
              </StackPanel>
            </Grid>

            <StackPanel Orientation="Horizontal" Margin="0,0,0,12">
              <Button x:Name="PickDirBtn" Content="选择文件夹" Style="{StaticResource Btn}"/>
              <Button x:Name="PickZipBtn" Content="选择 zip / mrpack" Style="{StaticResource Btn}" Margin="8,0,0,0"/>
              <Button x:Name="ClearBtn" Content="清空" Style="{StaticResource BtnGhost}" Margin="8,0,0,0"/>
            </StackPanel>

            <TextBlock Text="输入" Style="{StaticResource Label}"/>
            <TextBox x:Name="InputPath" Style="{StaticResource PathBox}"/>

            <TextBlock x:Name="InputMeta" Text="尚未选择" Style="{StaticResource Ink3}" Margin="0,8,0,0" TextWrapping="Wrap"/>

            <TextBlock Text="输出目录" Style="{StaticResource Label}" Margin="0,14,0,8"/>
            <Grid>
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
              </Grid.ColumnDefinitions>
              <TextBox x:Name="OutPath" Grid.Column="0" Style="{StaticResource PathBox}"/>
              <Button x:Name="PickOutBtn" Grid.Column="1" Content="改" Style="{StaticResource Btn}" Margin="8,0,0,0"/>
            </Grid>
            <TextBlock x:Name="OutputHint" Text="默认放在整合包同级目录，名字加 -server 后缀。"
                       Style="{StaticResource Ink3}" Margin="0,8,0,0" TextWrapping="Wrap"/>
          </StackPanel>
        </Border>

        <!-- ② 模式 -->
        <Border Style="{StaticResource Card}">
          <StackPanel>
            <TextBlock Text="模式" Style="{StaticResource CardTitle}"/>
            <TextBlock Text="两种模式跑的是同一套判定，区别只在判定结果是否生效。"
                       Style="{StaticResource Ink3}" Margin="0,3,0,12"/>
            <UniformGrid Columns="2">
              <RadioButton x:Name="ModeConservative" GroupName="mode" IsChecked="True" Style="{StaticResource Mode}" Margin="0,0,7,0">
                <StackPanel>
                  <TextBlock Text="保守" FontWeight="SemiBold"/>
                  <TextBlock Text="稳妥优先：以能顺利开服、客户端连服不出岔子为准。"
                             Style="{StaticResource Ink3}" TextWrapping="Wrap" Margin="0,3,0,0"/>
                </StackPanel>
              </RadioButton>
              <RadioButton x:Name="ModeAggressive" GroupName="mode" Style="{StaticResource Mode}" Margin="7,0,0,0">
                <StackPanel>
                  <TextBlock Text="激进" FontWeight="SemiBold"/>
                  <TextBlock Text="清理更彻底：剔除较多客户端模组，服务端包更干净。"
                             Style="{StaticResource Ink3}" TextWrapping="Wrap" Margin="0,3,0,0"/>
                </StackPanel>
              </RadioButton>
            </UniformGrid>
          </StackPanel>
        </Border>

        <!-- ③ 进度 -->
        <Border x:Name="ProgressCard" Style="{StaticResource Card}" Visibility="Collapsed">
          <StackPanel>
            <Grid>
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
              </Grid.ColumnDefinitions>
              <TextBlock x:Name="PhaseText" Grid.Column="0" Text="准备中" Style="{StaticResource CardTitle}"/>
              <TextBlock x:Name="PercentText" Grid.Column="1" Text="0%" Foreground="#c3c2b7" FontSize="12.5"
                         VerticalAlignment="Center"/>
            </Grid>
            <ProgressBar x:Name="Bar" Style="{StaticResource PBar}" Margin="0,10,0,0"/>
            <Grid Margin="0,12,0,0">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
              </Grid.ColumnDefinitions>
              <TextBlock x:Name="ProgressSub" Grid.Column="0" Text="" Style="{StaticResource Ink3}"
                         VerticalAlignment="Center" TextWrapping="Wrap"/>
              <Button x:Name="CancelBtn" Grid.Column="1" Content="取消" Style="{StaticResource Btn}" Margin="8,0,0,0"/>
            </Grid>
          </StackPanel>
        </Border>

        <!-- ④ 日志 -->
        <Border x:Name="LogCard" Style="{StaticResource Card}" Visibility="Collapsed">
          <StackPanel>
            <TextBlock Text="过程" Style="{StaticResource CardTitle}"/>
            <TextBox x:Name="LogBox" Style="{StaticResource Mono}" Height="170" Margin="0,10,0,0"/>
          </StackPanel>
        </Border>

        <!-- ⑤ 结果 -->
        <Border x:Name="ResultCard" Style="{StaticResource Card}" Visibility="Collapsed">
          <StackPanel>
            <TextBlock Text="结果" Style="{StaticResource CardTitle}"/>
            <TextBlock x:Name="ResultText" Text="" Style="{StaticResource Ink2}" Margin="0,8,0,0" TextWrapping="Wrap"/>
            <!-- 配色对应面板的 .modal .warn-box：琥珀色 12% 底 + 35% 描边 -->
            <Border x:Name="WarnBox" Background="#1Ffab219" BorderBrush="#59fab219" BorderThickness="1"
                    CornerRadius="9" Padding="11,10" Margin="0,12,0,0" Visibility="Collapsed">
              <TextBlock x:Name="WarnText" Text="" Foreground="#ffffff" FontSize="12.5" TextWrapping="Wrap" LineHeight="20"/>
            </Border>

            <TextBlock x:Name="ListTitle" Text="明细" Style="{StaticResource Label}" Margin="0,14,0,8"/>
            <ListBox x:Name="DetailList" Background="#0d0d0d" BorderBrush="#2c2c2a" BorderThickness="1"
                     Height="180" ItemContainerStyle="{StaticResource Item}" Padding="4"
                     ScrollViewer.HorizontalScrollBarVisibility="Disabled"/>

            <StackPanel Orientation="Horizontal" Margin="0,14,0,0">
              <Button x:Name="OpenOutBtn" Content="打开输出目录" Style="{StaticResource Btn}"/>
              <Button x:Name="OpenReportBtn" Content="查看报告" Style="{StaticResource Btn}" Margin="8,0,0,0"/>
            </StackPanel>
          </StackPanel>
        </Border>

      </StackPanel>
    </ScrollViewer>

    <Grid Grid.Row="2" Margin="0,4,0,0">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>
      <Button x:Name="StartBtn" Grid.Column="1" Content="开始制作" Style="{StaticResource BtnPrimary}" IsEnabled="False"/>
      <Button x:Name="QuitBtn" Grid.Column="2" Content="关闭启动器" Style="{StaticResource Btn}" Margin="8,0,0,0"/>
    </Grid>
  </Grid>
</Window>
'@

try {
  $win = [Windows.Markup.XamlReader]::Parse($xaml)
} catch {
  [System.Windows.Forms.MessageBox]::Show("界面加载失败：`n$($_.Exception.Message)", 'mcsp') | Out-Null
  exit 1
}

function Get-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  return $cmd.Source
}

$NodeExe = Get-Node
if (-not $NodeExe) {
  [System.Windows.Forms.MessageBox]::Show('找不到 node.exe。请先安装 Node.js 18 或更新版本，再打开本启动器。', 'mcsp') | Out-Null
  exit 1
}

$mcspJs = Join-Path $Root 'mcsp.js'
if (-not (Test-Path $mcspJs)) {
  [System.Windows.Forms.MessageBox]::Show("同目录下找不到 mcsp.js：`n$mcspJs", 'mcsp') | Out-Null
  exit 1
}

# ── 与子进程、系统窗口打交道的部分全部用 C# ───────────────────────────────
# 为什么不在 PowerShell 里挂 OutputDataReceived：那个回调跑在后台线程上，没有可用 runspace，
# 处理器里只要碰任何一个 PowerShell 变量或方法就会把整个进程带崩（空处理器 { } 反而不崩，极具迷惑性）。
# 所以读管道、入队都在 C# 里做完，PowerShell 只在 UI 线程上轮询队列。
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class Mcsp {
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}

// 顶层类：PowerShell 取嵌套类型要写 [Mcsp+Job]，不如拆出来直呼其名
public class McspJob {
  public Process Proc;
  private ConcurrentQueue<string> q = new ConcurrentQueue<string>();

  public McspJob(string exe, string args, string workdir) {
    ProcessStartInfo psi = new ProcessStartInfo(exe, args);
    psi.UseShellExecute = false;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    psi.CreateNoWindow = true;
    psi.StandardOutputEncoding = Encoding.UTF8;
    psi.StandardErrorEncoding = Encoding.UTF8;
    if (!String.IsNullOrEmpty(workdir)) psi.WorkingDirectory = workdir;
    Proc = new Process();
    Proc.StartInfo = psi;
    Proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) q.Enqueue(e.Data); };
    Proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) q.Enqueue("ERR\t" + e.Data); };
    Proc.Start();
    Proc.BeginOutputReadLine();
    Proc.BeginErrorReadLine();
  }

  public bool Running { get { try { return !Proc.HasExited; } catch { return false; } } }
  public int ExitCode { get { return Proc.ExitCode; } }
  public string[] Drain() {
    List<string> list = new List<string>();
    string s;
    while (q.TryDequeue(out s)) list.Add(s);
    return list.ToArray();
  }
  public void Kill() { try { Proc.Kill(); } catch { } }
}
'@
} catch { <# 已编译过 #> }
# 这段 C# 是启动器的命脉，编不出来就没法读子进程输出。不能静默吞掉编译错误。
if (-not ('McspJob' -as [type])) {
  [System.Windows.Forms.MessageBox]::Show(
    "启动器内部组件编译失败，无法运行。请在带 .NET Framework 的 Windows 上运行本工具。`n`n若反复出现，请把 gui.ps1 中 Add-Type 那段的报错一并反馈。",
    'mcsp') | Out-Null
  exit 1
}

# ── 小工具 ──────────────────────────────────────────────────────────────────

function Set-Status([string]$text, [string]$color = '#898781') {
  $win.FindName('StatusText').Text = $text
  $win.FindName('StatusText').Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString($color)
}

function Add-Log([string]$line) {
  $box = $win.FindName('LogBox')
  $box.AppendText($line + "`r`n")
  $box.ScrollToEnd()
}

$C = @{
  accent = '#1baf7a'; warning = '#fab219'; critical = '#d03b3b'
  ink1 = '#ffffff'; ink2 = '#c3c2b7'; ink3 = '#898781'
}
function Brush([string]$hex) { [Windows.Media.BrushConverter]::new().ConvertFromString($hex) }

# 标题栏跟随深色：老系统没有这个属性就静默跳过
function Set-DarkTitleBar($w) {
  $w.Add_SourceInitialized({
    try {
      $h = (New-Object System.Windows.Interop.WindowInteropHelper($w)).Handle
      $one = 1
      [void][Mcsp]::DwmSetWindowAttribute($h, 20, [ref]$one, 4)
      [void][Mcsp]::DwmSetWindowAttribute($h, 19, [ref]$one, 4)
    } catch { <# 不支持就算了 #> }
  })
}

# ── 输入选择 ────────────────────────────────────────────────────────────────

function Set-Input([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return }
  $path = $path.Trim('"')
  if (-not (Test-Path -LiteralPath $path)) {
    Set-Status('路径不存在', $C.critical)
    return
  }
  $item = Get-Item -LiteralPath $path
  if ($item.PSIsContainer) {
    if (-not (Test-Path (Join-Path $path 'mods'))) {
      $answer = [System.Windows.Forms.MessageBox]::Show(
        "这个文件夹里没有 mods 子目录，可能不是客户端实例。`n仍然用它作为输入吗？`n`n$path",
        'mcsp', 'YesNo', 'Warning')
      if ($answer -ne 'Yes') { return }
    }
  } elseif ($item.Extension.ToLower() -notin @('.zip', '.mrpack')) {
    [System.Windows.Forms.MessageBox]::Show('请选择文件夹，或 .zip / .mrpack 文件。', 'mcsp') | Out-Null
    return
  }

  $Script:LastInput = $path
  $win.FindName('InputPath').Text = $path
  $name = [IO.Path]::GetFileNameWithoutExtension($path)
  $out = Join-Path ([IO.Path]::GetDirectoryName($path)) "$name-server"
  $win.FindName('OutPath').Text = $out
  $win.FindName('StartBtn').IsEnabled = $true
  $win.FindName('ResultCard').Visibility = 'Collapsed'
  $win.FindName('ProgressCard').Visibility = 'Collapsed'
  $win.FindName('LogCard').Visibility = 'Collapsed'
  Set-Status('正在识别…')

  # 识别是纯读本地，很快；拿它把形态、加载器、模组数先摆出来
  try {
    $raw = & $NodeExe $mcspJs identify $path --json 2>$null
    $brief = ($raw | Select-Object -Last 1) | ConvertFrom-Json
    $loader = if ($brief.loader -and $brief.loader.name) {
      $brief.loader.name + $(if ($brief.loader.version) { ' ' + $brief.loader.version } else { '' })
    } else { '未识别' }
    $Script:LastKind = $brief.kind
    $win.FindName('InputMeta').Text = "形态：$($brief.kind)　加载器：$loader　游戏版本：$($brief.mcVersion)　文件数：$($brief.fileCount)"
    Set-Status('已选择，可以开始了', $C.accent)
  } catch {
    $win.FindName('InputMeta').Text = '识别失败，仍可继续（判定阶段会重新读一遍）'
    Set-Status('已选择，可以开始了', $C.accent)
  }
}

$win.FindName('PickDirBtn').Add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = '选择客户端整合包目录（含 mods 子目录的那一层）'
  $dlg.ShowNewFolderButton = $false
  if ($Script:LastInput -and (Test-Path -LiteralPath $Script:LastInput)) {
    $dlg.SelectedPath = if ((Get-Item -LiteralPath $Script:LastInput).PSIsContainer) { $Script:LastInput } else { [IO.Path]::GetDirectoryName($Script:LastInput) }
  }
  if ($dlg.ShowDialog() -eq 'OK') { Set-Input $dlg.SelectedPath }
})

$win.FindName('PickZipBtn').Add_Click({
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Title = '选择整合包压缩包'
  $dlg.Filter = '整合包 (*.zip;*.mrpack)|*.zip;*.mrpack|所有文件 (*.*)|*.*'
  if ($Script:LastInput -and (Test-Path -LiteralPath $Script:LastInput)) {
    $dlg.InitialDirectory = [IO.Path]::GetDirectoryName($Script:LastInput)
  }
  if ($dlg.ShowDialog() -eq 'OK') { Set-Input $dlg.FileName }
})

$win.FindName('ClearBtn').Add_Click({
  $Script:LastInput = ''
  $win.FindName('InputPath').Text = ''
  $win.FindName('OutPath').Text = ''
  $win.FindName('InputMeta').Text = '尚未选择'
  $win.FindName('StartBtn').IsEnabled = $false
  Set-Status('等待选择整合包')
})

$win.FindName('PickOutBtn').Add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = '选择输出目录（放服务端包的位置）'
  $dlg.ShowNewFolderButton = $true
  if ($win.FindName('OutPath').Text) { $dlg.SelectedPath = $win.FindName('OutPath').Text }
  if ($dlg.ShowDialog() -eq 'OK') { $win.FindName('OutPath').Text = $dlg.SelectedPath }
})

# 拖入：WPF 直接给本机路径，这是不走浏览器的最大好处，整个包不用复制一遍
$win.Add_DragOver({
  param($s, $e)
  $e.Effects = if ($e.Data.GetDataPresent([Windows.DataFormats]::FileDrop)) { 'Copy' } else { 'None' }
  $win.FindName('DropRing').Stroke = Brush '#1baf7a'
  $win.FindName('DropTitle').Foreground = Brush '#ffffff'
  $e.Handled = $true
})
$win.Add_DragLeave({
  $win.FindName('DropRing').Stroke = Brush '#3a3a37'
  $win.FindName('DropTitle').Foreground = Brush '#c3c2b7'
})
$win.Add_Drop({
  param($s, $e)
  $win.FindName('DropRing').Stroke = Brush '#3a3a37'
  $win.FindName('DropTitle').Foreground = Brush '#c3c2b7'
  if (-not $e.Data.GetDataPresent([Windows.DataFormats]::FileDrop)) { return }
  $paths = $e.Data.GetData([Windows.DataFormats]::FileDrop)
  if ($paths -and $paths.Count -gt 0) { Set-Input $paths[0] }
  $e.Handled = $true
})

# ── 使用前提示：点「开始制作」之后弹，与模式无关 ────────────────────────────

function Show-Notice {
  $notice = [Windows.Markup.XamlReader]::Parse(@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="mcsp — 使用前请知悉" SizeToContent="Height" Width="540"
        Background="#0d0d0d" Foreground="#ffffff" FontFamily="Microsoft YaHei UI" FontSize="13"
        WindowStartupLocation="CenterOwner" ResizeMode="NoResize" ShowInTaskbar="False">
  <Window.Resources>
    <ControlTemplate x:Key="T" TargetType="Button">
      <Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
              BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="8">
        <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/>
      </Border>
    </ControlTemplate>
    <Style x:Key="B" TargetType="Button">
      <Setter Property="Padding" Value="13,7"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template" Value="{StaticResource T}"/>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Opacity" Value="0.88"/>
        </Trigger>
      </Style.Triggers>
    </Style>
  </Window.Resources>
  <Border Background="#1a1a19" BorderBrush="#2c2c2a" BorderThickness="1" CornerRadius="14" Padding="20" Margin="10">
    <StackPanel>
      <TextBlock Text="关于服务端列表的红叉提示" FontSize="15" FontWeight="SemiBold" Margin="0,0,0,14"/>
      <Border Background="#2e2714" BorderBrush="#6b5a1f" BorderThickness="1" CornerRadius="9" Padding="11,10" Margin="0,0,0,14">
        <StackPanel>
          <TextBlock Text="玩家搜索服务端时有概率出现红叉报错，但是一般不影响游玩"
                     FontWeight="SemiBold" TextWrapping="Wrap" LineHeight="21"/>
          <TextBlock FontSize="12" Foreground="#c3c2b7" TextWrapping="Wrap" Margin="0,7,0,0" LineHeight="19"
                     Text="红叉来自客户端与服务端的模组列表不完全一致，通常只影响那一项提示本身，服务器照常可以进。真进不去多半是别的原因（游戏版本、白名单、端口转发）。"/>
        </StackPanel>
      </Border>
      <TextBlock Text="做完之后建议自己先连一次确认。" FontSize="12" Foreground="#898781" TextWrapping="Wrap"/>
      <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,18,0,0">
        <Button x:Name="Ok" Content="知道了" IsDefault="True" Style="{StaticResource B}" Background="#1baf7a" Foreground="#04150f" BorderBrush="Transparent" BorderThickness="1"/>
      </StackPanel>
    </StackPanel>
  </Border>
</Window>
'@)
  $notice.Owner = $win
  Set-DarkTitleBar $notice
  $notice.FindName('Ok').Add_Click({ $notice.Close() })
  # 回车（Ok 是默认按钮）与 Esc 都能关掉，提示框不该挡路
  $notice.Add_KeyDown({ if ($_.Key -eq 'Escape') { $notice.Close() } })
  $notice.ShowDialog() | Out-Null
}

$win.FindName('ModeAggressive').Add_Checked({
  if ($Script:Job -and $Script:Job.Job.Running) { return }
  Set-Status('已选择：激进', $C.warning)
})
$win.FindName('ModeConservative').Add_Checked({
  if ($Script:Job -and $Script:Job.Job.Running) { return }
  Set-Status('已选择：保守', $C.accent)
})

# ── 跑任务 ──────────────────────────────────────────────────────────────────

$win.FindName('StartBtn').Add_Click({
  $input = $win.FindName('InputPath').Text
  $out = $win.FindName('OutPath').Text
  if (-not $input -or -not (Test-Path -LiteralPath $input)) {
    [System.Windows.Forms.MessageBox]::Show('请先选择要处理的整合包。', 'mcsp') | Out-Null
    return
  }
  if (-not $out) {
    $name = [IO.Path]::GetFileNameWithoutExtension($input)
    $out = Join-Path ([IO.Path]::GetDirectoryName($input)) "$name-server"
    $win.FindName('OutPath').Text = $out
  }
  # 确认开始之前先把红叉提示说清楚：与模式无关，每次开跑都弹
  Show-Notice
  # 输出目录非空先问一句：同名模组会被替换掉
  if ((Test-Path -LiteralPath $out) -and (Get-ChildItem -LiteralPath $out -ErrorAction SilentlyContinue)) {
    $answer = [System.Windows.Forms.MessageBox]::Show(
      "输出目录已存在且非空：`n$out`n`n同名文件会被替换（server.properties 等已存在时保留不动）。继续吗？",
      'mcsp', 'YesNo', 'Warning')
    if ($answer -ne 'Yes') { return }
  }

  $mode = if ($win.FindName('ModeAggressive').IsChecked) { 'aggressive' } else { 'conservative' }
  Init-Weights $mode
  $args = @($mcspJs, 'make', $input, '-o', $out, '--json', '--force')
  if ($mode -eq 'conservative') { $args += '--conservative' }

  $argStr = ($args | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $job = New-Object McspJob($NodeExe, $argStr, $Root)

  $win.FindName('ResultCard').Visibility = 'Collapsed'
  $win.FindName('WarnBox').Visibility = 'Collapsed'
  $win.FindName('ProgressCard').Visibility = 'Visible'
  $win.FindName('LogCard').Visibility = 'Visible'
  $win.FindName('LogBox').Clear()
  $win.FindName('Bar').Value = 0
  $win.FindName('PercentText').Text = '0%'
  $win.FindName('PhaseText').Text = '准备中'
  $win.FindName('ProgressSub').Text = ''
  $win.FindName('StartBtn').IsEnabled = $false
  $win.FindName('CancelBtn').IsEnabled = $true

  $Script:Job = @{ Job = $job; Out = $out; Input = $input; Mode = $mode }
  $win.FindName('Scroller').ScrollToVerticalOffset(9999)  # 立刻把进度与日志露出来
  Set-Status('正在处理…', $C.accent)
})

$win.FindName('CancelBtn').Add_Click({
  if (-not $Script:Job -or -not $Script:Job.Job.Running) { return }
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "取消会直接结束打包进程，输出目录会留下不完整的文件。`n建议取消后先删掉输出目录再重跑。`n`n确定取消吗？",
    'mcsp', 'YesNo', 'Warning')
  if ($answer -ne 'Yes') { return }
  try { $Script:Job.Job.Kill() } catch { }
  Add-Log '已请求取消'
  $win.FindName('CancelBtn').IsEnabled = $false
  Set-Status('正在取消…', $C.warning)
})

$win.FindName('OpenOutBtn').Add_Click({
  $path = $win.FindName('OutPath').Text
  if ($path -and (Test-Path -LiteralPath $path)) { Start-Process explorer.exe $path } else { [System.Windows.Forms.MessageBox]::Show('输出目录还不存在。', 'mcsp') | Out-Null }
})
$win.FindName('OpenReportBtn').Add_Click({
  $path = Join-Path $win.FindName('OutPath').Text 'mcsp-report.json'
  if (Test-Path -LiteralPath $path) { Start-Process notepad.exe $path } else { [System.Windows.Forms.MessageBox]::Show('报告还没生成。', 'mcsp') | Out-Null }
})

$win.FindName('QuitBtn').Add_Click({
  if ($Script:Job -and $Script:Job.Job.Running) {
    $answer = [System.Windows.Forms.MessageBox]::Show('任务还在跑，关闭窗口会一并结束它。确定关闭吗？', 'mcsp', 'YesNo', 'Warning')
    if ($answer -ne 'Yes') { return }
    try { $Script:Job.Job.Kill() } catch { }
  }
  $win.Close()
})

# ── 事件解析 / 界面刷新（UI 线程上跑）──────────────────────────────────────

$PHASE = @{
  scan = '扫描模组'; online = '反查 Modrinth'; mcmod = '复核 MC百科'
  netgate = '扫网络通道'; write = '写出文件'; fetch = '取回加载器'
}

function Handle-Line([string]$line) {
  if ($line.StartsWith("ERR`t")) {
    $msg = $line.Substring(4).Trim()
    if ($msg) { Add-Log $msg }
    return
  }
  if (-not $line.StartsWith('{')) { if ($line.Trim()) { Add-Log $line }; return }
  $evt = $null
  try { $evt = $line | ConvertFrom-Json } catch { Add-Log $line; return }

  switch ($evt.t) {
    'start' { Add-Log "开始处理：$($evt.input)（$($evt.kind)）" }
    'phase' {
      $label = if ($PHASE.ContainsKey($evt.name)) { $PHASE[$evt.name] } else { $evt.name }
      $win.FindName('PhaseText').Text = $label
      if ($evt.total -gt 0) {
        $win.FindName('ProgressSub').Text = "$($evt.done) / $($evt.total)"
      }
      if ($evt.done -ge $evt.total) {
        $extra = if ($null -ne $evt.found) { "，命中 $($evt.found)" } else { '' }
        Add-Log "$label 完成（$($evt.total)$extra）"
      }
    }
    'mods' {
      $gated = [int]$evt.contentKept + [int]$evt.netKept + [int]$evt.depsKept
      Add-Log "判定完成：保留 $($evt.kept)，剔除 $($evt.dropped)，闸门拦回 $gated"
    }
    'mod' {
      # decision 是判定结论，kept 是实际有没有留下：留下就说「保留」，不做多余的注解
      $tag = if ($evt.decision -eq 'drop') { if ($evt.kept -eq $true) { '保留' } else { '剔除' } } else { '拦回' }
      Add-Log "  $tag $($evt.rel) — $($evt.reason)"
    }
    'mcmod' { Add-Log "  百科 $($evt.rel) → $($evt.env)" }
    'warn' { Add-Log "提示：$($evt.msg)" }
    'note' { Add-Log "说明：$($evt.msg)" }
    'done' { Add-Log "完成，输出目录：$($evt.out)" }
  }
}

function Set-Progress([double]$p) {
  if ($p -lt 0) { $p = 0 }
  if ($p -gt 1) { $p = 1 }
  $win.FindName('Bar').Value = $p * 100
  $win.FindName('PercentText').Text = "$([math]::Round($p * 100))%"
}

# 事件流里没有全量百分比，按阶段权重算一个总进度：切到哪个阶段，就把它之前各阶段视为已完成。
# 两种模式跑的是同一套流程（含 MC百科复核），所以共用一张表。
$Script:Weights = [ordered]@{ scan = 0.15; online = 0.05; mcmod = 0.5; netgate = 0.15; write = 0.1; fetch = 0.05 }
function Init-Weights([string]$mode) {
  $Script:Weights = [ordered]@{ scan = 0.15; online = 0.05; mcmod = 0.5; netgate = 0.15; write = 0.1; fetch = 0.05 }
}
function Tick-Progress([string]$name, [int]$done, [int]$total) {
  if (-not $Script:Weights.Contains($name)) { return }
  $order = @($Script:Weights.Keys)
  $before = 0.0
  for ($k = 0; $k -lt [array]::IndexOf($order, $name); $k++) { $before += [double]$Script:Weights[$order[$k]] }
  $frac = if ($total -gt 0) { [double]$done / $total } else { 1.0 }
  Set-Progress ($before + [double]$Script:Weights[$name] * $frac)
}

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(120)
$timer.Add_Tick({
  $j = $Script:Job
  if (-not $j) { return }
  # 1) 取走 C# 侧排好的行（队列由 C# 填，PowerShell 只在这一个线程上取，不跨线程）
  foreach ($line in $j.Job.Drain()) {
    if (-not $line) { continue }
    if ($line.StartsWith('{')) {
      try { $evt = $line | ConvertFrom-Json } catch { $evt = $null }
      if ($evt -and $evt.t -eq 'phase') { Tick-Progress $evt.name ([int]$evt.done) ([int]$evt.total) }
    }
    Handle-Line $line
  }
  # 2) 进程结束后收尾（再取一次，避免最后几行落在退出之后）
  if (-not $j.Job.Running -and -not $j.Finished) {
    $j.Finished = $true
    foreach ($line in $j.Job.Drain()) { if ($line) { Handle-Line $line } }
    Finish-Job $j
  }
})
$timer.Start()

function Finish-Job($j) {
  $code = $j.Job.ExitCode
  $win.FindName('CancelBtn').IsEnabled = $false
  $win.FindName('StartBtn').IsEnabled = $true
  $win.FindName('ResultCard').Visibility = 'Visible'
  Set-Progress 1

  $reportPath = Join-Path $j.Out 'mcsp-report.json'
  $report = $null
  if (Test-Path -LiteralPath $reportPath) {
    try { $report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
  }

  if ($code -eq 0 -or $code -eq 3) {
    $win.FindName('PhaseText').Text = '完成'
    $c = $report.counts
    $lines = @()
    $lines += "输出目录：$($j.Out)"
    if ($null -ne $c) {
      $lines += "模组 $($c.modsTotal) 个：保留 $($c.kept)，剔除 $($c.dropped)"
      $gated = [int]$c.contentKept + [int]$c.netKept + [int]$c.depsKept
      if ($gated -gt 0) { $lines += "闸门拦回 $gated 个（自有内容 $($c.contentKept)、网络通道 $($c.netKept)、被依赖 $($c.depsKept)）" }
      if ($c.mcmodFound -gt 0) { $lines += "MC百科复核到 $($c.mcmodFound) 条：据此挪回 $($c.mcmodRestored)，据此剔除 $($c.mcmodDropped)" }
      if ($c.conflicts -gt 0) { $lines += "其中 $($c.conflicts) 个作者声明两端通用仍被剔除，建议过目" }
    }
    $win.FindName('ResultText').Text = ($lines -join "`n")

    # 明细列表：逐条列出剔除的与三类闸门拦回的
    $win.FindName('DetailList').Items.Clear()
    if ($null -ne $report) {
      $drops = @($report.mods | Where-Object { $_.decision -eq 'drop' })
      $gatedList = @($report.mods | Where-Object { $_.decision -ne 'drop' -and $_.evidence -in @('content','net','deps') })
      $title = "已剔除 $($drops.Count) 个"
      if ($gatedList.Count -gt 0) { $title += "，闸门拦回 $($gatedList.Count) 个" }
      $win.FindName('ListTitle').Text = $title
      foreach ($m in $drops) { [void]$win.FindName('DetailList').Items.Add("剔除  $($m.rel)  —  $($m.reason)") }
      foreach ($m in $gatedList) { [void]$win.FindName('DetailList').Items.Add("拦回  $($m.rel)  —  $($m.reason)") }
    }

    # 需要提醒的：启发式剔除、冲突项、以及各类告警
    $warn = @()
    if ($null -ne $c -and $c.heuristicDropped -gt 0) { $warn += "有 $($c.heuristicDropped) 个模组是靠内置名单剔除的，不是硬证据，建议在报告里过目。" }
    if ($null -ne $c -and $c.conflicts -gt 0) { $warn += "有 $($c.conflicts) 个模组作者声明两端通用却被剔除，报告 conflicts 里列了。" }
    if ($null -ne $report -and $report.warnings) { foreach ($w in $report.warnings) { $warn += [string]$w } }
    if ($code -eq 3) { $warn += '存在完全无法判定的模组，已按「宁可多留」保留。' }
    if ($warn.Count -gt 0) {
      $win.FindName('WarnText').Text = ($warn -join "`n")
      $win.FindName('WarnBox').Visibility = 'Visible'
    }
    Set-Status('完成', $C.accent)
    Add-Log "完成（退出码 $code）"
    $win.FindName('Scroller').ScrollToVerticalOffset(9999)  # 结果卡在下面，滚过去让人一眼看到
  } else {
    $win.FindName('PhaseText').Text = '失败'
    $win.FindName('ResultText').Text = "处理失败，退出码 $code。上面日志里有原因。"
    Set-Status('失败', $C.critical)
    Add-Log "失败（退出码 $code）"
  }
  $Script:Job = $null
}

# 关闭窗口 = 结束启动器（任务在跑时先问一句）
$win.Add_Closing({
  param($s, $e)
  if ($Script:Job -and $Script:Job.Job.Running) {
    $answer = [System.Windows.Forms.MessageBox]::Show('任务还在跑，关闭窗口会一并结束它。确定关闭吗？', 'mcsp', 'YesNo', 'Warning')
    if ($answer -ne 'Yes') { $e.Cancel = $true; return }
    try { $Script:Job.Job.Kill() } catch { }
  }
  $timer.Stop()
})

$win.FindName('VersionText').Text = "mcsp $((& $NodeExe $mcspJs --version 2>$null) -join '')"
$win.FindName('ModeConservative').IsChecked = $true
Set-Status('等待选择整合包')

Set-DarkTitleBar $win

# 窗口真正建起来之后再收掉控制台：启动阶段的任何报错（脚本被策略拦下、文件带下载标记）
# 都要能看见，一旦界面出来，控制台就没用了，留着只是碍事。
$win.Add_SourceInitialized({
  try {
    $h = [Mcsp]::GetConsoleWindow()
    if ($h -ne [IntPtr]::Zero) { [void][Mcsp]::ShowWindow($h, 0) }
  } catch { <# 没有控制台就忽略 #> }
})

[void]$win.ShowDialog()
[void]$Script:Mutex.ReleaseMutex()
