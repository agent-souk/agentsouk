"""jobs.pay_gasless against a mock transport: terms -> consistency check -> signer -> facilitator -> hash submit.

Run with `python -m pytest sdk-python/tests` or directly `python sdk-python/tests/test_pay_gasless.py`.
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import httpx  # noqa: E402

from agentsouk import AgentSouk, AgentSoukError  # noqa: E402

BUYER = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A"
SELLER = "0xA0a2494006B72109137630bC026434a809731c07"
USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
REQ = {"scheme": "exact", "network": "eip155:84532", "amount": "70000", "asset": USDC, "payTo": SELLER, "maxTimeoutSeconds": 900, "extra": {"name": "USDC", "version": "2"}}
AUTH = {"from": BUYER, "to": SELLER, "value": "70000", "validAfter": "0", "validBefore": "1800000000", "nonce": "0x" + "ab" * 32}


def terms():
    return {
        "error": {"type": "payment_error", "code": "payment_required", "message": "pay"},
        "job_id": "job_1", "amount": 70000, "price": 70000, "already_paid": 0, "currency": "USDC", "display": "0.070000 USDC", "network": "eip155:84532", "chain_id": 84532,
        "asset": USDC, "pay_to": SELLER, "pay_from": BUYER, "pay_by": None, "steps": [],
        "gasless": {
            "method": "eip3009_transfer_with_authorization", "summary": "", "valid_before": "2027-01-15T08:00:00.000Z",
            "typed_data": {"types": {}, "primaryType": "TransferWithAuthorization", "domain": {"name": "USDC", "version": "2", "chainId": 84532, "verifyingContract": USDC}, "message": {"from": BUYER, "to": SELLER, "value": 70000, "validAfter": 0, "validBefore": 1800000000, "nonce": AUTH["nonce"]}},
            "settle_url": "https://x402.org/facilitator/settle", "facilitator": "https://x402.org/facilitator",
            "settle_body": {"x402Version": 2, "paymentPayload": {"x402Version": 2, "resource": {"url": "u", "description": "d", "mimeType": "application/json"}, "accepted": REQ, "payload": {"signature": "<sig>", "authorization": AUTH}}, "paymentRequirements": REQ},
            "signature_placeholder": "<sig>", "steps": [], "sign_with": {}, "fallback": "send it yourself",
        },
        "x402": {}, "facilitator": {"url": "", "how": ""},
    }


class World:
    def __init__(self):
        self.terms = terms()
        self.facilitator = []  # bodies received
        self.pays = []  # hashes submitted to the platform
        self.answer = lambda body: httpx.Response(200, json={"success": True, "transaction": "0x" + "ab" * 32})
        self.pending_once = True

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith("https://x402.org/facilitator/settle"):
            assert "authorization" not in {k.lower() for k in request.headers.keys()}, "the API key must never reach the facilitator"
            assert request.headers["content-type"] == "application/json"
            body = json.loads(request.content)
            self.facilitator.append(body)
            return self.answer(body)
        if url.endswith("/v1/jobs/job_1/pay"):
            body = json.loads(request.content) if request.content else {}
            if body.get("transaction"):
                self.pays.append(body["transaction"])
                if self.pending_once and len(self.pays) == 1:
                    return httpx.Response(409, json={"error": {"type": "state_error", "code": "transaction_pending", "message": "wait", "details": {"retry_after_seconds": 0}}})
                if body["transaction"] == "0x" + "77" * 32:
                    return httpx.Response(409, json={"error": {"type": "state_error", "code": "transaction_not_found", "message": "not yet", "hint": "retry", "details": {"retry_after_seconds": 0}}})
                return httpx.Response(200, json={"object": "job", "id": "job_1", "payment": {"status": "paid"}, "output": {"ok": True}})
            return httpx.Response(402, json=copy.deepcopy(self.terms))
        return httpx.Response(404, json={"error": {"type": "not_found", "code": "not_found", "message": url}})

    def client(self):
        return AgentSouk(api_key="as_test_x", base_url="http://localhost:8787", transport=httpx.MockTransport(self.handler))


def expect_error(fn, code):
    try:
        fn()
    except AgentSoukError as e:
        assert e.code == code, (e.code, str(e))
        return e
    raise AssertionError(f"expected {code}")


def test_happy_path_signs_settles_and_submits():
    w = World()
    aw = w.client()
    signed = []

    def signer(td):
        signed.append(td)
        assert td["message"]["value"] == 70000
        return "cd" * 65  # hex without 0x: normalised

    job = aw.jobs.pay_gasless("job_1", signer, interval=0)
    assert job["payment"]["status"] == "paid"
    assert len(signed) == 1 and len(w.facilitator) == 1
    assert w.facilitator[0]["paymentPayload"]["payload"]["signature"] == "0x" + "cd" * 65
    assert w.pays == ["0x" + "ab" * 32, "0x" + "ab" * 32]  # pending once, then paid: same hash
    assert w.terms["gasless"]["settle_body"]["paymentPayload"]["payload"]["signature"] == "<sig>"  # terms not mutated


def test_bytes_and_long_smart_wallet_signatures_pass_through():
    w = World()
    aw = w.client()
    aw.jobs.pay_gasless("job_1", lambda td: bytes.fromhex("ef" * 65), interval=0)
    assert w.facilitator[-1]["paymentPayload"]["payload"]["signature"] == "0x" + "ef" * 65
    w.pending_once = False
    aw.jobs.pay_gasless("job_1", lambda td: "0x" + "12" * 130, interval=0)
    assert w.facilitator[-1]["paymentPayload"]["payload"]["signature"] == "0x" + "12" * 130
    expect_error(lambda: aw.jobs.pay_gasless("job_1", lambda td: "garbage"), "signature_invalid")
    expect_error(lambda: aw.jobs.pay_gasless("job_1", lambda td: "0x" + "ab" * 10), "signature_invalid")
    assert len(w.facilitator) == 2


def test_declines_are_final_and_unknown_fates_resend_the_same_body():
    w = World()
    aw = w.client()
    w.answer = lambda body: httpx.Response(400, json={"success": False, "errorReason": "insufficient_funds"})
    e = expect_error(lambda: aw.jobs.pay_gasless("job_1", lambda td: "0x" + "cd" * 65), "facilitator_declined")
    assert "insufficient_funds" in str(e) and "jobs.pay" in (e.hint or "") and e.status == 400
    assert len(w.facilitator) == 1
    w.answer = lambda body: httpx.Response(200, json={"success": False, "errorReason": "invalid_exact_evm_payload_signature"})
    expect_error(lambda: aw.jobs.pay_gasless("job_1", lambda td: "0x" + "cd" * 65), "facilitator_declined")
    assert len(w.facilitator) == 2

    def boom(body):
        raise httpx.ConnectError("ECONNRESET")

    w.answer = boom
    import agentsouk as pkg

    real_sleep = pkg.time.sleep
    pkg.time.sleep = lambda s: None
    try:
        e = expect_error(lambda: aw.jobs.pay_gasless("job_1", lambda td: "0x" + "cd" * 65), "facilitator_unknown")
        assert "Do NOT sign" in (e.hint or "")
        assert e.details["settle_body"]["paymentPayload"]["payload"]["signature"] == "0x" + "cd" * 65
        assert len(w.facilitator) == 5 and len({json.dumps(b, sort_keys=True) for b in w.facilitator[2:]}) == 1  # three identical attempts
        w.answer = lambda body: httpx.Response(503, text="<html>bad gateway</html>")
        expect_error(lambda: aw.jobs.pay_gasless("job_1", lambda td: "0x" + "cd" * 65), "facilitator_unknown")
        assert len(w.facilitator) == 8
        w.answer = lambda body: httpx.Response(200, json={"success": True, "transaction": "pending"})
        expect_error(lambda: aw.jobs.pay_gasless("job_1", lambda td: "0x" + "cd" * 65), "facilitator_unknown")
        assert len(w.facilitator) == 9
    finally:
        pkg.time.sleep = real_sleep


def test_platform_failure_after_broadcast_keeps_the_hash():
    w = World()
    aw = w.client()
    w.pending_once = False
    w.answer = lambda body: httpx.Response(200, json={"success": True, "transaction": "0x" + "77" * 32})
    e = expect_error(lambda: aw.jobs.pay_gasless("job_1", lambda td: "0x" + "cd" * 65, retries=1, interval=0), "transaction_not_found")
    assert e.details["transaction"] == "0x" + "77" * 32
    assert "do not sign a new authorization" in (e.hint or "")


def test_refuses_to_sign_inconsistent_terms_and_needs_a_wallet():
    w = World()
    aw = w.client()
    w.terms["gasless"]["typed_data"]["message"]["to"] = "0x" + "11" * 20
    signed = []
    expect_error(lambda: aw.jobs.pay_gasless("job_1", lambda td: signed.append(td) or "0x" + "cd" * 65), "terms_inconsistent")
    assert not signed and not w.facilitator
    w.terms = terms()
    w.terms["gasless"]["settle_body"]["paymentPayload"]["accepted"] = dict(REQ, amount="70001")
    expect_error(lambda: aw.jobs.pay_gasless("job_1", lambda td: "0x" + "cd" * 65), "terms_inconsistent")
    w.terms = terms()
    w.terms["gasless"] = None
    expect_error(lambda: aw.jobs.pay_gasless("job_1", lambda td: "0x" + "cd" * 65), "wallet_address_required")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("python pay_gasless tests passed")
