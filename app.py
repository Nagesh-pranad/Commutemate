"""
app.py — CommuteMate+ Flask Backend (v2)
Fixes:
  1. Source location taken from user (no hardcoded default)
  2. Improved metro detection using keyword list
  3. Booking redirects to Ola/Uber/Rapido (no fake OTP)
"""

import json
import math
import os
import uuid
from datetime import datetime, timedelta

import requests
from flask import Flask, jsonify, render_template, request

from calendar_reader import get_event_by_id, load_events, save_event

app = Flask(__name__)

# ──────────────────────────────────────────────
# FIX 2: Bangalore metro area keywords
# Metro available when BOTH source AND destination match
# ──────────────────────────────────────────────
BANGALORE_METRO_AREAS = [
    "whitefield", "indiranagar", "indira nagar", "mg road", "majestic",
    "jayanagar", "kengeri", "rajajinagar", "btm", "electronic city",
    "banashankari", "vijayanagar", "hebbal", "yelahanka", "koramangala",
    "marathahalli", "kr puram", "byappanahalli", "banaswadi",
    "ramamurthy nagar", "domlur", "halasuru", "lalbagh", "srirampura",
    "peenya", "yeshwanthpur", "jalahalli", "dasarahalli", "nagasandra",
    "chickpete", "baiyappanahalli", "hsr layout", "jp nagar",
    "bannerghatta", "silk board", "btm layout", "bommanahalli",
    "jayadeva", "yelachenahalli", "konanakunte", "thalaghattapura",
    "bangalore", "bengaluru", "malleswaram", "rajajinagar", "ulsoor",
    "brigade road", "cubbon park", "vidhana soudha", "sarjapur",
    "varthur", "hbr layout", "horamavu",
]

LOCATIONS_FILE = os.path.join(os.path.dirname(__file__), "locations.json")
with open(LOCATIONS_FILE) as f:
    FALLBACK_LOCATIONS = json.load(f)


def haversine(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def geocode(location: str):
    try:
        params = {"q": location, "format": "json", "limit": 1}
        headers = {"User-Agent": "CommuteMate+/2.0"}
        resp = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params=params, headers=headers, timeout=5,
        )
        data = resp.json()
        if data:
            return {"lat": float(data[0]["lat"]), "lon": float(data[0]["lon"]),
                    "display_name": data[0].get("display_name", location)}
    except Exception:
        pass
    # fallback
    key = location.lower().strip()
    for k, v in FALLBACK_LOCATIONS.items():
        if k in key or key in k:
            return {"lat": v["lat"], "lon": v["lon"], "display_name": v["name"]}
    return None


def is_metro_area(location: str) -> bool:
    loc_lower = location.lower()
    return any(kw in loc_lower for kw in BANGALORE_METRO_AREAS)


def compute_leave_by(event_time_str: str, travel_minutes: int) -> str:
    try:
        t = datetime.strptime(event_time_str, "%H:%M")
        leave = t - timedelta(minutes=travel_minutes + 10)
        return leave.strftime("%I:%M %p")
    except Exception:
        return "N/A"


@app.route("/")
def index():
    return render_template("index.html", events=load_events())


@app.route("/events")
def get_events():
    return jsonify(load_events())


@app.route("/add-event", methods=["POST"])
def add_event():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    source = data.get("source", "").strip()
    destination = data.get("destination", "").strip()
    date = data.get("date", "").strip()
    time_str = data.get("time", "").strip()

    if not all([name, source, destination, date, time_str]):
        return jsonify({"error": "All fields are required including Source Location"}), 400

    event = {
        "id": str(uuid.uuid4()),
        "name": name,
        "source": source,
        "destination": destination,
        "date": date,
        "time": time_str,
        "created_at": datetime.utcnow().isoformat(),
    }
    save_event(event)
    return jsonify({"success": True, "event": event}), 201


@app.route("/plan", methods=["POST"])
def plan_commute():
    data = request.get_json() or {}
    event = get_event_by_id(data.get("event_id"))
    if not event:
        return jsonify({"error": "Event not found"}), 404

    source = event.get("source", "").strip()
    destination = event.get("destination", "").strip()

    if not source:
        return jsonify({"error": "Source location missing. Please re-add the event with a source location."}), 400

    src_coords = geocode(source)
    if not src_coords:
        return jsonify({"error": f"Source not found: '{source}'. Try a Bangalore locality name."}), 400

    dst_coords = geocode(destination)
    if not dst_coords:
        return jsonify({"error": f"Destination not found: '{destination}'. Try a Bangalore locality name."}), 400

    distance_km = round(haversine(src_coords["lat"], src_coords["lon"],
                                   dst_coords["lat"], dst_coords["lon"]), 1)

    cab_time = max(5, round(distance_km * 2))
    cab_fare = round(distance_km * 16)

    # FIX 2: keyword-based metro check
    has_metro = is_metro_area(source) and is_metro_area(destination)
    metro = None
    if has_metro:
        metro = {
            "time": max(5, round(cab_time * 0.6)),
            "fare": max(10, round(distance_km * 4)),
        }

    recommended = "cab"
    if metro:
        recommended = "metro" if (metro["time"] < cab_time or metro["fare"] < cab_fare) else "cab"

    ref_time = metro["time"] if (metro and recommended == "metro") else cab_time
    leave_by = compute_leave_by(event["time"], ref_time)

    maps_metro_url = (
        f"https://www.google.com/maps/dir/?api=1"
        f"&origin={requests.utils.quote(source)}"
        f"&destination={requests.utils.quote(destination)}"
        f"&travelmode=transit"
    )

    return jsonify({
        "event": event,
        "source_resolved": src_coords.get("display_name", source),
        "destination_resolved": dst_coords.get("display_name", destination),
        "distance_km": distance_km,
        "cab": {"time": cab_time, "fare": cab_fare},
        "metro": metro,
        "metro_available": has_metro,
        "recommended": recommended,
        "leave_by": leave_by,
        "source": source,
        "maps_metro_url": maps_metro_url,
        "dest_lat": dst_coords["lat"],
        "dest_lon": dst_coords["lon"],
    })


# FIX 3: return provider links, no OTP or fake confirmation
@app.route("/book", methods=["POST"])
def book():
    data = request.get_json() or {}
    transport = data.get("transport")
    event = get_event_by_id(data.get("event_id"))
    if not event:
        return jsonify({"error": "Event not found"}), 404

    destination = event.get("destination", "")
    source = event.get("source", "")

    if transport == "cab":
        providers = [
            {
                "name": "Ola",
                "icon": "🟢",
                "color": "#2ecc71",
                "url": f"https://ola.onelink.me/yG1k?pid=referral&c=web&drop_name={requests.utils.quote(destination)}",
                "display_url": "olacabs.com",
            },
            {
                "name": "Uber",
                "icon": "⚫",
                "color": "#e0e0e0",
                "url": f"https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[formatted_address]={requests.utils.quote(destination)}",
                "display_url": "m.uber.com",
            },
            {
                "name": "Rapido",
                "icon": "🟡",
                "color": "#f5a623",
                "url": "https://www.rapido.bike",
                "display_url": "rapido.bike",
            },
        ]
        return jsonify({"success": True, "transport": "cab", "providers": providers})

    elif transport == "metro":
        maps_url = (
            f"https://www.google.com/maps/dir/?api=1"
            f"&origin={requests.utils.quote(source)}"
            f"&destination={requests.utils.quote(destination)}"
            f"&travelmode=transit"
        )
        providers = [
            {
                "name": "Google Maps (Transit)",
                "icon": "🗺️",
                "color": "#4f8aff",
                "url": maps_url,
                "display_url": "maps.google.com",
            },
            {
                "name": "Namma Metro (BMRCL)",
                "icon": "🚇",
                "color": "#3ecfff",
                "url": "https://english.bmrc.co.in/",
                "display_url": "bmrc.co.in",
            },
        ]
        return jsonify({"success": True, "transport": "metro", "providers": providers})

    return jsonify({"error": "Invalid transport type"}), 400


@app.route("/delete-event", methods=["POST"])
def delete_event_route():
    from calendar_reader import delete_event
    data = request.get_json() or {}
    event_id = data.get("event_id")
    if not event_id:
        return jsonify({"error": "No event_id"}), 400
    delete_event(event_id)
    return jsonify({"success": True})


if __name__ == "__main__":
    app.run(debug=True, port=5000)