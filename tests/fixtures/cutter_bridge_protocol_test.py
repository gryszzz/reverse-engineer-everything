"""Producer-level regression tests for Cutter's authenticated local protocol."""

import hashlib
import hmac
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
import uuid
from pathlib import Path


def _install_host_stubs():
    cutter = types.ModuleType("cutter")
    cutter.CutterPlugin = type("CutterPlugin", (), {})
    sys.modules["cutter"] = cutter
    qtcore = types.ModuleType("PySide6.QtCore")
    qtcore.QObject = type("QObject", (), {})
    qtcore.Signal = lambda *_args: object()
    pyside = types.ModuleType("PySide6")
    pyside.QtCore = qtcore
    sys.modules["PySide6"] = pyside
    sys.modules["PySide6.QtCore"] = qtcore


_install_host_stubs()
MODULE_PATH = Path(__file__).parents[2] / "bridge" / "cutter" / "rea_bridge.py"
spec = importlib.util.spec_from_file_location("rea_cutter_bridge_test", MODULE_PATH)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)


def _frame(connection):
    data = bytearray()
    while b"\n" not in data:
        data.extend(connection.recv(4096))
        if len(data) > bridge.MAX_FRAME_BYTES:
            raise AssertionError("oversized test frame")
    line, remainder = bytes(data).split(b"\n", 1)
    if remainder:
        raise AssertionError("unexpected pipelined frame")
    return json.loads(line)


def _send(connection, value):
    connection.sendall(json.dumps(value, separators=(",", ":")).encode() + b"\n")


class Dispatcher:
    generation = 4
    current_file = "/tmp/sample.bin"
    cutter_version = "test"

    def __init__(self):
        self.dispatch = self
        self.commands = []
        self.completed_commands = {}
        self.lock = threading.Lock()
        self.command_started = threading.Event()
        self.finish_command = threading.Event()
        self.status_queued = threading.Event()

    def _read_current_file(self):
        return self.current_file

    def can_accept_command(self):
        return len(self.completed_commands) < bridge.MAX_COMPLETION_RECEIPTS

    def emit(self, request, reply):
        def run():
            kind = request.get("kind")
            if kind == "command":
                self.command_started.set()
            elif kind == "status":
                self.status_queued.set()
            with self.lock:
                if kind == "command":
                    self.finish_command.wait(2)
                self.commands.append(kind)
                if kind == "status":
                    reply.update({"ok": True, "session_id": request["session_id"], "document_generation": self.generation,
                                  "current_file": self.current_file, "cutter_version": self.cutter_version,
                                  "identity_status": "partial", "completed_commands": [
                                      {"request_id": request_id, "execution_state": state}
                                      for request_id, state in self.completed_commands.items()
                                  ]})
                elif kind == "ack":
                    reply.update({"ok": True, "acknowledged": self.completed_commands.pop(request["request_id"], None) is not None})
                else:
                    reply.update({"ok": True, "execution_state": "complete"})
                    if kind == "command" and isinstance(request.get("request_id"), str):
                        self.completed_commands[request["request_id"]] = "complete"
                request["_event"].set()
        threading.Thread(target=run, daemon=True).start()


class ServeDispatcher:
    """Small UI-dispatcher stand-in for real producer/client interoperability."""

    generation = 4
    current_file = "/tmp/cutter-interop-雪.bin"
    cutter_version = "fixture"

    def __init__(self):
        self.dispatch = self
        self.completed_commands = {}
        self.fail_next_ack = False
        self.malformed_next_ack = False
        self.hide_receipts_after_ack_failure = False

    def can_accept_command(self):
        return len(self.completed_commands) < bridge.MAX_COMPLETION_RECEIPTS

    def _read_current_file(self):
        return self.current_file

    def emit(self, request, reply):
        if request.get("kind") == "status":
            reply.update({
                "ok": True,
                "session_id": request["session_id"],
                "document_generation": self.generation,
                "current_file": self.current_file,
                "cutter_version": self.cutter_version,
                "identity_status": "partial",
                "completed_commands": [
                    {"request_id": request_id, "execution_state": state}
                    for request_id, state in self.completed_commands.items()
                ] if not self.hide_receipts_after_ack_failure else [],
            })
        elif request.get("kind") == "ack":
            if self.malformed_next_ack:
                self.malformed_next_ack = False
                reply.update({"ok": True, "session_id": request["session_id"]})
                request["_event"].set()
                return
            if self.fail_next_ack:
                self.fail_next_ack = False
                self.hide_receipts_after_ack_failure = True
                reply.update({"ok": False, "acknowledged": False})
                request["_event"].set()
                return
            reply.update({
                "ok": True,
                "acknowledged": self.completed_commands.pop(request["request_id"], None) is not None,
            })
            self.hide_receipts_after_ack_failure = False
        elif request.get("kind") == "command" and request.get("expected_generation") != self.generation:
            reply.update({
                "ok": False,
                "error": "active-document-generation-changed",
                "execution_state": "not_started",
            })
            self.completed_commands[request["request_id"]] = "not_started"
        elif request.get("kind") == "command" and request.get("command") == "fixture-unknown":
            reply.update({
                "ok": False,
                "error": "fixture-response-lost-after-completion",
                "execution_state": "unknown",
            })
            self.completed_commands[request["request_id"]] = "complete"
        elif request.get("kind") == "command" and request.get("command") == "fixture-fail-ack":
            reply.update({
                "ok": True,
                "output": "ack will fail once",
                "current_file": self.current_file,
                "document_generation": self.generation,
                "cutter_version": self.cutter_version,
                "identity_status": "partial",
                "execution_state": "complete",
            })
            self.completed_commands[request["request_id"]] = "complete"
            self.fail_next_ack = True
        elif request.get("kind") == "command" and request.get("command") == "fixture-malformed-ack":
            reply.update({
                "ok": True,
                "output": "ack reply will be malformed once",
                "current_file": self.current_file,
                "document_generation": self.generation,
                "cutter_version": self.cutter_version,
                "identity_status": "partial",
                "execution_state": "complete",
            })
            self.completed_commands[request["request_id"]] = "complete"
            self.malformed_next_ack = True
        else:
            reply.update({
                "ok": True,
                "output": 'round-trip: 雪 ☃️ quote=" slash=\\\\ line=\\n tab=\\t',
                "current_file": self.current_file,
                "document_generation": self.generation,
                "cutter_version": self.cutter_version,
                "identity_status": "partial",
                "execution_state": "complete",
            })
            if request.get("kind") == "command":
                self.completed_commands[request["request_id"]] = "complete"
        request["_event"].set()


def run_serve_mode():
    server = bridge._BridgeServer(ServeDispatcher())
    server.start()
    try:
        deadline = time.monotonic() + 5
        while not server.descriptor.exists() and time.monotonic() < deadline:
            time.sleep(0.005)
        if not server.descriptor.exists():
            raise RuntimeError("bridge descriptor was not published")
        print("ready", flush=True)
        sys.stdin.buffer.readline()
    finally:
        server.stop()
        server.join(timeout=3)


class ProtocolProducerTest(unittest.TestCase):
    def test_rejects_legacy_peers_before_ui_dispatch(self):
        with socket.create_connection(("127.0.0.1", self.server.port), timeout=2) as connection:
            connection.sendall((json.dumps({"kind": "rea-auth-v1", "nonce": "a" * 64}) + "\n").encode())
            with connection.makefile("rb") as reader:
                reply = json.loads(reader.readline())
        self.assertEqual(reply, {"ok": False, "error": "authentication-failed"})
        self.assertEqual(self.dispatcher.commands, [])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.environ["REA_CUTTER_BRIDGE_DIR"] = self.temp.name
        self.dispatcher = Dispatcher()
        self.server = bridge._BridgeServer(self.dispatcher)
        bridge.SOCKET_TIMEOUT_SECONDS = 0.1
        self.server.start()
        deadline = time.monotonic() + 2
        while not self.server.descriptor.exists() and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertTrue(self.server.descriptor.exists())

    def tearDown(self):
        self.server.stop()
        self.server.join(timeout=2)
        os.environ.pop("REA_CUTTER_BRIDGE_DIR", None)
        self.temp.cleanup()

    def exchange(self, request):
        token = self.server.token.encode()
        client_nonce = os.urandom(32).hex()
        with socket.create_connection(("127.0.0.1", self.server.port), timeout=1) as connection:
            _send(connection, {"kind": "rea-auth-v2", "nonce": client_nonce})
            challenge = _frame(connection)
            self.assertEqual(challenge["session_id"], self.server.session_id)
            server_nonce = challenge["nonce"]
            expected_server = hmac.new(token, f"rea-cutter-server-v2:{self.server.session_id}:{client_nonce}:{server_nonce}".encode(), hashlib.sha256).hexdigest()
            self.assertTrue(hmac.compare_digest(challenge["proof"], expected_server))
            request_bytes = json.dumps(request, separators=(",", ":"))
            proof = hmac.new(token, f"rea-cutter-client-v2:{self.server.session_id}:{client_nonce}:{server_nonce}:{request_bytes}".encode(), hashlib.sha256).hexdigest()
            _send(connection, {"request": request_bytes, "proof": proof})
            frame = _frame(connection)
            if "response" not in frame:
                return frame, client_nonce
            response = frame["response"]
            expected_response = hmac.new(token, f"rea-cutter-response-v2:{self.server.session_id}:{client_nonce}:{server_nonce}:{response}".encode(), hashlib.sha256).hexdigest()
            self.assertTrue(hmac.compare_digest(frame["proof"], expected_response))
            return json.loads(response), client_nonce

    def test_request_session_uuid_is_checked_after_secret_proof(self):
        spoofed = {"kind": "status", "session_id": "client-chosen-session"}
        response, _ = self.exchange(spoofed)
        self.assertEqual(response["error"], "authentication-failed")
        self.assertEqual(self.dispatcher.commands, [])

    def test_client_chosen_session_uuid_without_secret_proof_is_not_authenticated(self):
        client_nonce = os.urandom(32).hex()
        with socket.create_connection(("127.0.0.1", self.server.port), timeout=1) as connection:
            _send(connection, {"kind": "rea-auth-v2", "nonce": client_nonce})
            _frame(connection)
            request_bytes = json.dumps({"kind": "status", "session_id": "client-chosen-session"}, separators=(",", ":"))
            _send(connection, {"request": request_bytes, "proof": "0" * 64})
            self.assertEqual(_frame(connection)["error"], "authentication-failed")
        self.assertEqual(self.dispatcher.commands, [])

    def test_cancelled_command_receipt_survives_later_command_until_acknowledged(self):
        dispatcher = object.__new__(bridge._RequestDispatcher)
        dispatcher.generation = 4
        dispatcher.current_file = "/tmp/sample.bin"
        dispatcher.cutter_version = "test"
        dispatcher.completed_commands = {}
        dispatcher._receipt_lock = threading.Lock()
        dispatcher._refresh_document_identity = lambda: None
        bridge.cutter.cmd = lambda command: f"output:{command}"

        def handle(value):
            request = {
                **value,
                "_event": threading.Event(),
                "_cancelled": threading.Event(),
            }
            reply = {}
            bridge._RequestDispatcher._handle(dispatcher, request, reply)
            self.assertTrue(request["_event"].is_set())
            return reply

        request_a = "4b18ce4d-bf31-456e-ae31-e8c547b2f9db"
        request_b = "8ca93d11-107d-41ed-8b40-31dd53cd26a6"
        for request_id, command in ((request_a, "A"), (request_b, "B")):
            result = handle({
                "kind": "command",
                "request_id": request_id,
                "expected_generation": 4,
                "command": command,
            })
            self.assertTrue(result["ok"])

        status = handle({"kind": "status"})
        self.assertEqual(
            {receipt["request_id"] for receipt in status["completed_commands"]},
            {request_a, request_b},
        )
        acknowledged = handle({"kind": "ack", "request_id": request_a})
        self.assertTrue(acknowledged["acknowledged"])
        after_ack = handle({"kind": "status"})
        self.assertEqual(
            [receipt["request_id"] for receipt in after_ack["completed_commands"]],
            [request_b],
        )

    def test_stale_generation_rejections_are_terminal_and_acknowledged(self):
        dispatcher = object.__new__(bridge._RequestDispatcher)
        dispatcher.generation = 4
        dispatcher.current_file = "/tmp/sample.bin"
        dispatcher.cutter_version = "test"
        dispatcher.completed_commands = {}
        dispatcher._receipt_lock = threading.Lock()
        dispatcher._refresh_document_identity = lambda: None

        def handle(value):
            request = {
                **value,
                "_event": threading.Event(),
                "_cancelled": threading.Event(),
            }
            reply = {}
            bridge._RequestDispatcher._handle(dispatcher, request, reply)
            self.assertTrue(request["_event"].is_set())
            return reply

        invalid_id = str(uuid.UUID(int=bridge.MAX_COMPLETION_RECEIPTS + 10))
        invalid = handle({
            "kind": "command",
            "request_id": invalid_id,
            "expected_generation": 4,
            "command": "",
        })
        self.assertEqual(invalid["execution_state"], "not_started")
        self.assertTrue(handle({"kind": "ack", "request_id": invalid_id})["acknowledged"])

        for index in range(bridge.MAX_COMPLETION_RECEIPTS + 1):
            request_id = str(uuid.UUID(int=index + 1))
            response = handle({
                "kind": "command",
                "request_id": request_id,
                "expected_generation": 3,
                "command": "iI",
            })
            self.assertEqual(response["execution_state"], "not_started")
            self.assertEqual(response["error"], "active-document-generation-changed")
            self.assertTrue(handle({"kind": "ack", "request_id": request_id})["acknowledged"])

        self.assertEqual(dispatcher.completed_commands, {})
        self.assertTrue(dispatcher.can_accept_command())

    def test_poisoned_rejection_is_definitively_not_started_without_dispatch(self):
        self.server.poisoned = True
        response, _ = self.exchange({
            "kind": "command",
            "session_id": self.server.session_id,
            "request_id": "4b18ce4d-bf31-456e-ae31-e8c547b2f9db",
        })
        self.assertEqual(response["error"], "session-poisoned-after-ui-timeout")
        self.assertEqual(response["execution_state"], "not_started")
        self.assertEqual(self.dispatcher.commands, [])

    def test_receipt_capacity_rejects_before_ui_dispatch(self):
        self.dispatcher.can_accept_command = lambda: False
        response, _ = self.exchange({
            "kind": "command",
            "session_id": self.server.session_id,
            "request_id": "4b18ce4d-bf31-456e-ae31-e8c547b2f9db",
        })
        self.assertEqual(response["error"], "completion-receipt-capacity-exceeded")
        self.assertEqual(response["execution_state"], "not_started")
        self.assertEqual(self.dispatcher.commands, [])

    def test_status_probe_recovers_only_after_timed_out_ui_operation_finishes(self):
        timed_out, _ = self.exchange({"kind": "command", "session_id": self.server.session_id})
        self.assertEqual(timed_out["error"], "ui-thread-request-timeout")
        self.assertTrue(self.server.poisoned)
        self.assertTrue(self.dispatcher.command_started.wait(1))
        result = {}
        status_thread = threading.Thread(target=lambda: result.setdefault(
            "response", self.exchange({"kind": "status", "session_id": self.server.session_id})[0]
        ))
        status_thread.start()
        self.assertTrue(self.dispatcher.status_queued.wait(1))
        self.dispatcher.finish_command.set()
        status_thread.join(timeout=2)
        self.assertFalse(status_thread.is_alive())
        response = result["response"]
        self.assertTrue(response["ok"])
        self.assertEqual(response["session_id"], self.server.session_id)
        self.assertEqual(self.dispatcher.commands, ["command", "status"])

    def test_escape_expansion_uses_a_signed_truthful_truncation_fallback(self):
        sender, receiver = socket.socketpair()
        try:
            self.server._send_authenticated(sender, {
                "ok": True,
                "output": '"' * 6_000_000,
                "execution_state": "complete",
                "current_file": "/tmp/sample.bin",
                "document_generation": 4,
                "identity_status": "partial",
            }, "a" * 64, "b" * 64)
            frame_bytes = receiver.recv(bridge.MAX_FRAME_BYTES + 1)
            self.assertLessEqual(len(frame_bytes), bridge.MAX_FRAME_BYTES)
            frame = json.loads(frame_bytes)
            response = frame["response"]
            expected = hmac.new(
                self.server.token.encode(),
                f"rea-cutter-response-v2:{self.server.session_id}:{'a' * 64}:{'b' * 64}:{response}".encode(),
                hashlib.sha256,
            ).hexdigest()
            self.assertTrue(hmac.compare_digest(frame["proof"], expected))
            value = json.loads(response)
            self.assertEqual(value["ok"], True)
            self.assertEqual(value["execution_state"], "complete")
            self.assertTrue(value["output_truncated"])
            self.assertIsNone(value["output"])
        finally:
            sender.close()
            receiver.close()


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve"]:
        run_serve_mode()
    else:
        unittest.main()
