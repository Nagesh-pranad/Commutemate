"""
calendar_reader.py
Handles reading and writing of events from/to events.json
"""

import json
import os
from datetime import datetime

EVENTS_FILE = os.path.join(os.path.dirname(__file__), "events.json")


def load_events():
    """Load all events from events.json"""
    try:
        with open(EVENTS_FILE, "r") as f:
            events = json.load(f)
        # Sort by date/time ascending
        events.sort(key=lambda e: (e.get("date", ""), e.get("time", "")))
        return events
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_event(event: dict):
    """Append a new event to events.json"""
    events = load_events()
    events.append(event)
    with open(EVENTS_FILE, "w") as f:
        json.dump(events, f, indent=2)
    return event


def get_event_by_id(event_id: str):
    """Fetch a single event by its ID"""
    events = load_events()
    for ev in events:
        if ev.get("id") == event_id:
            return ev
    return None


def delete_event(event_id: str):
    """Delete an event by ID"""
    events = load_events()
    events = [e for e in events if e.get("id") != event_id]
    with open(EVENTS_FILE, "w") as f:
        json.dump(events, f, indent=2)
