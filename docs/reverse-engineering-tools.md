# Reverse-engineering tool integrations

REA can call caller-supplied GNU objdump, GDB, and Rizin installations. REA does not install or update these tools. Static objdump/Rizin workflows use the same services from CLI and MCP. GDB's persistent MCP sessions and ephemeral CLI command are available only on Linux. Persistent debugger sessions exist only for the lifetime of the REA MCP server process.

In a shared MCP server, unrestricted Rizin and Cutter commands, GDB console
commands, Rizin debugger start/close, and GDB debugger close retire any active
binary analysis session after the operation. This prevents a fresh analysis
provider from being rebound automatically while command effects may still be
writing. After the command and any background writers have stopped, call
`open_binary` explicitly before continuing analysis. A successful command
response alone does not prove that background writers have stopped. An active
Ghidra analysis session must be closed explicitly before an external mutation
can run.

## GNU objdump

`inspect_with_objdump` and `rea inspect-with-objdump` capture stdout and stderr as inline Evidence. Artifact inspection Evidence records SHA-256 digests before and after the provider call and whether those observed digests differ; this cannot prove the exact bytes consumed if the artifact changes during execution. Choose one artifact operation: `file_headers`, `section_headers`, `symbols`, `relocations`, `dwarf`, `disassemble`, or `disassemble_all`. `disassemble` maps to `-d`; `disassemble_all` maps to `-D` and has different symbol-boundary semantics. The pathless `inspect_with_objdump {"operation":"architectures"}` MCP call or `rea list-objdump-architectures` CLI command maps to `-i` and produces subjectless provider-capability Evidence describing BFD targets compiled into the installed binary, not a guarantee that a target is supported.

For DWARF, REA does not follow local debug links by default. Set `follow_debug_links` to `true` to pass `-WK`; external debug-file identities are not bound to Evidence when following links is enabled. The CLI option is `--follow-debug-links true`. REA clears `DEBUGINFOD_URLS` in the objdump child environment to disable debuginfod network access on GNU binutils versions that do not support `-WE`. The complete raw output is authoritative; REA does not normalize it into a version-independent disassembly schema.

```sh
rea inspect-with-objdump ./program disassemble
rea inspect-with-objdump ./program dwarf --follow-debug-links false
```

Captured stdout and stderr are retained up to a 16 MiB combined limit; `output_truncated` marks output beyond that limit.

## GDB

Persistent GDB sessions, including the MCP workflow and one-shot `rea debug-with-gdb` CLI, are available only on Linux. REA verifies a live inferior's output descriptors through `/proc` before detaching it; it does not claim equivalent descriptor verification on macOS. Windows is also unsupported because owned Job Object cleanup can terminate debugger inferiors. On supported Linux hosts, `start_gdb_session`, `gdb_console`, `gdb_session_status`, and `close_gdb_session` manage a persistent GDB/MI session in MCP. The one-shot CLI requires a caller-selected durable TTY: `rea debug-with-gdb --inferior-tty /dev/pts/7 'file ./program'`. The TTY must remain available after GDB exits so a detached inferior can continue writing. MCP starts GDB with `--nx --quiet --interpreter=mi3`, retries initialization with MI2 if MI3 initialization returns an error and cleanup succeeds, waits for its prompt, and disables auto-loading. Pass optional `inferior_tty` to select the terminal that future inferior runs use; REA configures it before the session becomes ready and checks the exact value with GDB/MI. `gdb_session_status` reports the selected path, whether REA still considers the configuration verified, and whether invalid UTF-8 has been observed in MI bytes (`mi_invalid_utf8`) or stderr (`stderr_invalid_utf8`). Commands that can change the inferior TTY or redirect a run revoke that verification permanently for the session, so close retains GDB ownership if a live inferior remains. Closing a session with one live inferior and a verified TTY automatically detaches the target, which can resume execution; MCP clients receive destructive-operation annotations for this behavior. The console remains unrestricted and can run shell commands, change target state, access files, and use network in the REA process user's security context. Raw MI records and console/target/log streams are returned with Evidence; command output is retained up to 16 MiB and explicitly marked when truncated.

Before a normal close, REA checks for live GDB thread groups. If one remains and a durable `inferior_tty` is verified, REA asks GDB to detach it and confirms the detach before stopping the debugger. Without that sink, select and apply a disposition to each inferior through `gdb_console` (for example, detach or kill as appropriate), then retry close. REA never infers target ownership from a PID or path. When the MCP server shuts down, REA terminates only its directly owned GDB process after confirming no inferior or a sink-backed detach; otherwise it retains the process and its output streams for retry.

```text
start_gdb_session {"inferior_tty":"/dev/pts/7"}
gdb_console {"session_id":"…","command":"file ./program"}
gdb_console {"session_id":"…","command":"info files"}
gdb_session_status {"session_id":"…"}
close_gdb_session {"session_id":"…"}
```

## Rizin

`start_rizin_debug_session` and `rea debug-with-rizin` require an explicit `inferior_tty` on Linux. Rizin launches the target with stdout and stderr routed to that caller-selected TTY and `dbg.exitkills=false`; the target can therefore continue running and writing to the TTY after REA closes the debugger. This is a visible target output effect, and the caller is responsible for selecting a suitable terminal that remains available. Before closing, REA serializes after the active command, parses the structured `olj` descriptor list, detaches only a unique `ptrace://` descriptor, confirms its absence, reads back `dbg.exitkills=false`, and verifies `/proc/<pid>/fd/1` and `/proc/<pid>/fd/2` still identify the selected TTY by device and inode. Any malformed or ambiguous readback keeps the Rizin session owned for retry. Persistent Rizin debugger sessions are unavailable outside Linux because this verification depends on `/proc`.

Persistent command Evidence retains the caller-selected and resolved startup paths in `parameters.launch_provenance`. These paths describe launch provenance, not the current target after unrestricted commands. `rizin_debug_session_status.output_invalid_utf8` reports whether lossy frame decoding has been observed during the session. Command Evidence sets `output_invalid_utf8` only when loss was observed in frames collected for that command, including retained partial output; earlier startup or command frames do not mark later valid output as lossy.

```sh
rea debug-with-rizin --inferior-tty /dev/pts/7 ./program dr
```

`execute_rizin_command` and `rea execute-rizin-command` run one selected command against a local artifact. The one-shot profile uses `-N -q -c`, suppressing user settings and scripts while leaving plugins available. Commands and plugins run with the REA process user's security context and may access files, the network, or perform other actions. REA preserves raw output and does not claim that command-specific JSON has one universal schema.

```sh
rea execute-rizin-command ./program iI
```

Captured stdout and stderr are retained up to a 16 MiB combined limit; `output_truncated` marks output beyond that limit.

## Cutter bridge

Cutter commands use the local REA Python bridge and authenticated loopback messages.
The client and plugin must support the current v2 handshake; older peers are
rejected before dispatch because they cannot preserve cross-caller recovery proof.
The client checks the final encoded request against the bridge's 16 MiB frame
limit before dispatch; an oversized command does not retain a cleanup owner.
Discovery admits at most 256 descriptor candidates and reads and probes at most
eight concurrently. A larger directory reports `bridge_directory_capacity_exceeded`.

Terminal receipts are recovered before another command, including from a new CLI
invocation. A signed status response also confirms completion of older bridge
connections after its UI dispatch, preserving recovery proof for a caller whose
receipt another caller has acknowledged. Neither receipt recovery nor a status
probe retries the original command. Failed acknowledgements remain pending and
block new commands until they can be retried successfully.

## Configuration and coverage

The optional `REA_OBJDUMP_COMMAND`, `REA_GDB_COMMAND`, and `REA_RIZIN_COMMAND` values select executable names or paths; otherwise REA searches `PATH`. Values are passed directly to process spawning, not expanded as shell command lines. Provider versions and capabilities remain unknown until observed from the installed tool and verified in the corresponding real-provider lane.

Provider capture limits are separate from the MCP response budget. A result that fits the provider limit may still exceed the default 10 MiB MCP response budget and return a transport `resource_constraint`. Configure `REA_MCP_MAX_RESPONSE_BYTES` to match a larger client receive buffer when that client supports one; otherwise use retained Evidence/export or complete CLI JSON output. See [MCP response limits](./mcp-contracts.md#tool-results).
