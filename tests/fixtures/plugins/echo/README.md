# echo

The test plugin of the plugin mechanism. It registers one tool, `echo.say`, which answers the text it is given behind
the prefix in `ECHO_PREFIX` (default `echo: `), and ships one skill, `echo-say`, that names the tool.

Tests copy this folder into the private layer's `plugins.local/` and run it with `neptunia plugin run echo`. It keeps no
state and is never installed on a deployment.
