"""streaming 单元测试"""
import asyncio

import pytest

from browser_use_service.streaming import (
    ReactStep, StepKind, StepPublisher,
    make_thought, make_action, make_observation, make_error, make_final,
)


@pytest.mark.asyncio
async def test_publisher_basic_publish():
    pub = StepPublisher("t1")
    received = []

    async def cb(step):
        received.append(step)

    pub.subscribe(cb)
    s = make_thought("t1", 1, "thinking...")
    await pub.publish(s)
    assert len(received) == 1
    assert received[0].kind == StepKind.THOUGHT


@pytest.mark.asyncio
async def test_publisher_multiple_subscribers():
    pub = StepPublisher("t2")
    a, b = [], []
    pub.subscribe(lambda s: a.append(s))
    pub.subscribe(lambda s: b.append(s))
    await pub.publish(make_action("t2", 1, "click('#x')"))
    assert len(a) == 1 and len(b) == 1
    assert a[0].content == "click('#x')"


@pytest.mark.asyncio
async def test_publisher_close_stops_stream():
    pub = StepPublisher("t3")
    pub.close()
    await pub.publish(make_thought("t3", 1, "ignored"))
    # close 后 publish 不应抛错
    assert pub._closed


@pytest.mark.asyncio
async def test_subscriber_exception_does_not_break_publisher():
    pub = StepPublisher("t4")
    received = []

    async def bad_cb(step):
        raise RuntimeError("oops")

    async def good_cb(step):
        received.append(step)

    pub.subscribe(bad_cb)
    pub.subscribe(good_cb)
    await pub.publish(make_observation("t4", 1, "obs"))
    assert len(received) == 1


def test_step_to_dict_serialization():
    s = ReactStep(
        task_id="t5", step_index=2, kind=StepKind.ACTION,
        content="click('#y')", url="https://example.com",
    )
    d = s.to_dict()
    assert d["task_id"] == "t5"
    assert d["kind"] == "action"
    assert d["content"] == "click('#y')"
    assert d["url"] == "https://example.com"


def test_makers_return_correct_kinds():
    assert make_thought("t", 1, "x").kind == StepKind.THOUGHT
    assert make_action("t", 1, "x").kind == StepKind.ACTION
    assert make_observation("t", 1, "x").kind == StepKind.OBSERVATION
    assert make_error("t", 1, "x").kind == StepKind.ERROR
    assert make_final("t", "result").kind == StepKind.FINAL
