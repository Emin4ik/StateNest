# Reproducible terminal recording of the zero-touch two-machine flow.
#
# Requires VHS (https://github.com/charmbracelet/vhs):
#
#   brew install vhs          # or: go install github.com/charmbracelet/vhs@latest
#   npm run build
#   vhs scripts/recording/zero-touch.tape
#
# Produces docs/assets/zero-touch.gif. That file is deliberately NOT committed:
# it is a binary that would grow the repository on every re-record, and this
# tape regenerates it from the real product in about a minute.
#
# Everything recorded is real output from scripts/demo-zero-touch.mjs, which
# drives the actual Claude Code hook entry points and the actual background
# sync against throwaway homes in the system temp directory.

Output docs/assets/zero-touch.gif

Set Shell bash
Set FontSize 15
Set Width 1100
Set Height 780
Set Padding 18
Set Theme "Builtin Dark"
Set TypingSpeed 60ms
Set PlaybackSpeed 1.0

Hide
Type "clear" Enter
Show

Type "npm run demo:zero-touch"
Sleep 600ms
Enter

# The demo paces itself; this just needs to outlast it.
Sleep 75s
