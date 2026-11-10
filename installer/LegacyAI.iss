#ifndef AppVersion
#error Pass AppVersion from installer/Build.ps1
#endif
#ifndef Payload
#define Payload "..\.build\payload"
#endif
#ifndef VCRedist
#define VCRedist "..\.build\vc_redist.x64.exe"
#endif

[Setup]
AppId={{5BCA7661-5144-46C9-8FD1-54D17258EA9B}
AppName=Legacy AI
AppVersion={#AppVersion}
AppPublisher=Legacy Studios
DefaultDirName={localappdata}\Programs\Legacy AI
DefaultGroupName=Legacy AI
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\release
OutputBaseFilename=Legacy-AI-{#AppVersion}-Windows-x64-Setup
SetupIconFile={#Payload}\desktop\Legacy.ico
WizardImageFile=WizardLogo.bmp
WizardSmallImageFile=WizardSmallLogo.bmp
UninstallDisplayIcon={app}\desktop\Legacy.ico
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"

[Files]
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "\config.json"
Source: "{#Payload}\config.json"; DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "{#VCRedist}"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedVCRedist

[Icons]
Name: "{group}\Legacy AI"; Filename: "{app}\Start Legacy.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\desktop\Legacy.ico"
Name: "{group}\Configure Connections"; Filename: "{app}\Start Legacy.cmd"; Parameters: "configure"; WorkingDir: "{app}"; IconFilename: "{app}\desktop\Legacy.ico"
Name: "{group}\Connect LinkedIn"; Filename: "{app}\Start Legacy.cmd"; Parameters: "linkedin"; WorkingDir: "{app}"; IconFilename: "{app}\desktop\Legacy.ico"
Name: "{group}\Connect Instagram"; Filename: "{app}\Start Legacy.cmd"; Parameters: "instagram"; WorkingDir: "{app}"; IconFilename: "{app}\desktop\Legacy.ico"
Name: "{group}\Connect TikTok"; Filename: "{app}\Start Legacy.cmd"; Parameters: "tiktok"; WorkingDir: "{app}"; IconFilename: "{app}\desktop\Legacy.ico"
Name: "{group}\Install Browser Runtime"; Filename: "{app}\Start Legacy.cmd"; Parameters: "browser"; WorkingDir: "{app}"; IconFilename: "{app}\desktop\Legacy.ico"
Name: "{group}\Setup Guide"; Filename: "{app}\Setup Guide.txt"
Name: "{autodesktop}\Legacy AI"; Filename: "{app}\Start Legacy.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\desktop\Legacy.ico"; Tasks: desktopicon

[Run]
Filename: "{tmp}\vc_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing Microsoft Visual C++ Runtime..."; Verb: "runas"; Flags: shellexec waituntilterminated; Check: NeedVCRedist
Filename: "{app}\Start Legacy.cmd"; Description: "Open Legacy AI"; Flags: postinstall shellexec nowait skipifsilent

[Code]
function NeedVCRedist: Boolean;
var
  Installed, Minor: Cardinal;
begin
  Result := not (RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Installed', Installed) and
    (Installed = 1) and RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Minor', Minor) and
    (Minor >= 40));
end;
