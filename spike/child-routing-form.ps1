# A classic Win32 window for the child-routing test.
#
# Windows 11 ships Notepad as a XAML app with no child windows, so it cannot
# show whether a posted mouse message reaches the right control. A WinForms
# form is built from real Win32 control windows, which is the case this probe
# needs: the text box below is its own HWND inside the form's client area.
#
# The form must not activate when it appears. A window that raises itself leaves
# whatever was in the foreground sitting behind it, and the test could then no
# longer tell whether the posted input raised it or it had raised itself. This
# subclass suppresses that activation so the foreground at the start of the test
# is still a window the probe does not own.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System.Windows.Forms;

public class SilentForm : Form
{
    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams parameters = base.CreateParams;
            parameters.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            return parameters;
        }
    }
}
'@ -ReferencedAssemblies System.Windows.Forms

$form = New-Object SilentForm
$form.Text = 'DSH Child Routing Probe'
$form.ClientSize = New-Object System.Drawing.Size(640, 220)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(80, 80)

$label = New-Object System.Windows.Forms.Label
$label.Text = 'target field below'
$label.Left = 24
$label.Top = 24
$label.Width = 400
$form.Controls.Add($label)

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'probeField'
$box.Left = 24
$box.Top = 64
$box.Width = 560
$box.Height = 32
$form.Controls.Add($box)

# Run the message loop so the window stays alive and pumps posted messages.
[void][System.Windows.Forms.Application]::Run($form)
