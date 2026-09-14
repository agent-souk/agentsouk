"""AgentSouk.buy against a mock transport: order -> wait -> pay gas-free -> reveal -> accept, and the declined case pays nothing.

Run with `python -m pytest sdk-python/tests`.
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import httpx  # noqa: E402

from agentsouk import AgentSouk, AgentSoukError  # noqa: E402
from test_pay_gasless import World  # noqa: E402


class Market(World):
    """A job that is open for two polls, then delivered sealed; paying reveals it; accepting completes it."""

    def __init__(self, outcome="delivered"):
        super().__init__()
        self.pending_once = False
        self.outcome = outcome
        self.polls = 0
        self.paid = False
        self.accepted = False
        self.created = []

    def job(self):
        if self.polls < 2:
            status = "open"
        else:
            status = self.outcome
        if self.accepted:
            status = "completed"
        sealed = status == "delivered" and not self.paid
        return {"object": "job", "id": "job_1", "status": status, "output_sealed": sealed, "output": None if sealed or status != "delivered" and status != "completed" else {"ok": True}, "cancel_reason": "not today" if status == "declined" else None, "quoted_price": None}

    def handler(self, request):
        url = str(request.url)
        if url.endswith("/v1/jobs") and request.method == "POST":
            self.created.append(json.loads(request.content))
            return httpx.Response(201, json={"object": "job", "id": "job_1", "status": "open", "output_sealed": False, "output": None})
        if url.endswith("/v1/jobs/job_1") and request.method == "GET":
            self.polls += 1
            return httpx.Response(200, json=self.job())
        if url.endswith("/v1/jobs/job_1/events"):
            return httpx.Response(200, json={"object": "list", "data": [{"type": "created", "data": {}}, {"type": "declined", "data": {"reason": "not today"}}] if self.outcome == "declined" else []})
        if url.endswith("/v1/jobs/job_1/accept"):
            self.accepted = True
            return httpx.Response(200, json=self.job())
        if url.endswith("/v1/jobs/job_1/pay"):
            body = json.loads(request.content) if request.content else {}
            if body.get("transaction"):
                self.pays.append(body["transaction"])
                self.paid = True
                return httpx.Response(200, json=self.job())
            return httpx.Response(402, json=copy.deepcopy(self.terms))
        return super().handler(request)


def test_buy_orders_waits_pays_reveals_and_accepts():
    m = Market()
    aw = m.client()
    job = aw.buy("lst_1", {"q": 1}, lambda td: "cd" * 65, interval=0)
    assert len(m.created) == 1 and m.created[0]["listing_id"] == "lst_1" and m.created[0]["input"] == {"q": 1}
    assert job["status"] == "completed"
    assert job["output"] == {"ok": True}
    assert len(m.facilitator) == 1 and len(m.pays) == 1


def test_buy_without_accept_leaves_the_job_delivered_and_revealed():
    m = Market()
    job = m.client().buy("lst_1", {}, lambda td: "cd" * 65, accept=False, interval=0)
    assert job["status"] == "delivered" and job["output"] == {"ok": True} and not m.accepted


def test_declined_job_pays_nothing_and_says_why():
    m = Market(outcome="declined")
    try:
        m.client().buy("lst_1", {}, lambda td: "cd" * 65, interval=0)
    except AgentSoukError as e:
        assert e.code == "buy_not_delivered"
        assert "Nothing was paid" in e.hint and 'The seller said: "not today"' in e.hint
    else:
        raise AssertionError("expected buy_not_delivered")
    assert m.facilitator == [] and m.pays == []


def test_quoted_job_pays_nothing():
    m = Market(outcome="quoted")
    try:
        m.client().buy("lst_1", {}, lambda td: "cd" * 65, interval=0)
    except AgentSoukError as e:
        assert e.code == "buy_needs_quote"
    else:
        raise AssertionError("expected buy_needs_quote")
    assert m.facilitator == []
