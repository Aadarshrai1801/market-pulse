"""
Authentication & user management for MarketPulse.

- Session-based login (Flask's signed cookie session — no extra dependency).
- Users live in a small SQLite database (users.db by default).
- Three roles, each a superset of the one before it:
    viewer  - can log in and view fetched data / history / charts, nothing else
    editor  - viewer + can trigger fetches (/api/fetch, /api/jobs) and OCR scans
    admin   - editor + can manage user accounts (create, change role,
              deactivate, reset password, delete)

Wire this into app.py like:

    from auth import auth_bp, init_auth, login_required, role_required, current_user

    app.secret_key = "..."           # see _load_or_create_secret_key() in app.py
    init_auth(app)
    app.register_blueprint(auth_bp)

    @app.route("/")
    @login_required
    def index(): ...

    @app.route("/api/fetch", methods=["POST"])
    @role_required("editor", "admin")
    def api_fetch(): ...
"""

import os
import secrets
import sqlite3
import time
from collections import defaultdict
from datetime import datetime
from functools import wraps
from urllib.parse import urlencode

import requests
from flask import Blueprint, request, jsonify, session, render_template, redirect, url_for, g
from werkzeug.security import generate_password_hash, check_password_hash

DB_PATH = os.environ.get("USERS_DB_PATH", "users.db")
ROLES = ("viewer", "editor", "admin")
ROLE_RANK = {"viewer": 0, "editor": 1, "admin": 2}

# ------------------------------------------------------------------
# Basic login rate limiting (in-process - fine for a single gunicorn
# worker, which is what this app should run as; see JOBS note in app.py).
# For anything beyond a single worker/instance, swap this for
# Flask-Limiter backed by Redis instead.
# ------------------------------------------------------------------
LOGIN_RATE_LIMIT = 8            # attempts...
LOGIN_RATE_WINDOW_SECONDS = 300  # ...per rolling 5 minutes, per IP
_login_attempts = defaultdict(list)


def _login_rate_limited(ip):
    now = time.time()
    attempts = [t for t in _login_attempts[ip] if now - t < LOGIN_RATE_WINDOW_SECONDS]
    _login_attempts[ip] = attempts
    return len(attempts) >= LOGIN_RATE_LIMIT


def _record_login_attempt(ip):
    _login_attempts[ip].append(time.time())

# ------------------------------------------------------------------
# Google OAuth config
# ------------------------------------------------------------------
# Set these three env vars to turn on the "Continue with Google" button.
# Create credentials at https://console.cloud.google.com/apis/credentials
# (OAuth client ID -> Web application) and add GOOGLE_REDIRECT_URI as an
# authorized redirect URI there, e.g. https://yourdomain.com/auth/google/callback
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI", "")

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

# New accounts created via "Continue with Google" get this role. An admin
# can promote them afterwards from the User Management panel.
GOOGLE_DEFAULT_ROLE = os.environ.get("GOOGLE_DEFAULT_ROLE", "viewer")

auth_bp = Blueprint("auth", __name__)


def google_oauth_configured():
    return bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI)


# ------------------------------------------------------------------
# DB setup
# ------------------------------------------------------------------

def _get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_column(conn, table, column, coltype_sql):
    """Adds `column` to `table` if it isn't there yet — lets older users.db
    files (from before Google login / last-seen tracking existed) upgrade
    in place instead of needing to be deleted and recreated."""
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype_sql}")


def init_auth(app):
    """
    Create the users table if it doesn't exist yet, and seed a first admin
    account if the table is empty. Call this once at startup, before
    app.run() — see app.py.
    """
    conn = _get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('viewer','editor','admin')),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        )
    """)
    conn.commit()

    # Additive migrations — safe to run every startup.
    _ensure_column(conn, "users", "auth_provider", "TEXT NOT NULL DEFAULT 'local'")
    _ensure_column(conn, "users", "google_id", "TEXT")
    _ensure_column(conn, "users", "avatar_url", "TEXT")
    _ensure_column(conn, "users", "last_login_at", "TEXT")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)")
    conn.commit()

    count = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    if count == 0:
        default_user = os.environ.get("ADMIN_USERNAME", "admin")
        default_pass = os.environ.get("ADMIN_PASSWORD", "admin123")
        conn.execute(
            "INSERT INTO users (username, password_hash, role, is_active, created_at) "
            "VALUES (?, ?, 'admin', 1, ?)",
            (default_user, generate_password_hash(default_pass),
             datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
        )
        conn.commit()
        print(
            f"[auth] No users found — created default admin account "
            f"'{default_user}' / '{default_pass}'. Log in and change the "
            f"password immediately (or set ADMIN_USERNAME / ADMIN_PASSWORD "
            f"env vars before the very first run)."
        )
    conn.close()


# ------------------------------------------------------------------
# User helpers (plain functions — no ORM, keeps this dependency-free)
# ------------------------------------------------------------------

def get_user_by_id(user_id):
    conn = _get_conn()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_user_by_username(username):
    conn = _get_conn()
    row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()
    return dict(row) if row else None


def list_users(search=None, role=None, status=None):
    """
    Returns users, optionally filtered by a case-insensitive username
    substring (`search`), an exact `role`, and `status` ('active' /
    'inactive'). All filters are optional and combine with AND.
    """
    query = (
        "SELECT id, username, role, is_active, created_at, auth_provider, "
        "avatar_url, last_login_at FROM users WHERE 1=1"
    )
    params = []

    if search:
        query += " AND username LIKE ?"
        params.append(f"%{search.strip()}%")
    if role in ROLES:
        query += " AND role = ?"
        params.append(role)
    if status == "active":
        query += " AND is_active = 1"
    elif status == "inactive":
        query += " AND is_active = 0"

    query += " ORDER BY id"

    conn = _get_conn()
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_user_stats():
    """Summary counters for the User Management panel's stats bar."""
    all_users = list_users()
    return {
        "total": len(all_users),
        "active": sum(1 for u in all_users if u["is_active"]),
        "inactive": sum(1 for u in all_users if not u["is_active"]),
        "admins": sum(1 for u in all_users if u["role"] == "admin"),
        "editors": sum(1 for u in all_users if u["role"] == "editor"),
        "viewers": sum(1 for u in all_users if u["role"] == "viewer"),
        "google_linked": sum(1 for u in all_users if u["auth_provider"] == "google"),
    }


def create_user(username, password, role):
    username = (username or "").strip()
    if role not in ROLES:
        raise ValueError(f"Invalid role '{role}'. Must be one of {ROLES}.")
    if not username:
        raise ValueError("Username is required.")
    if not password or len(password) < 6:
        raise ValueError("Password must be at least 6 characters.")
    if get_user_by_username(username):
        raise ValueError(f"Username '{username}' is already taken.")

    conn = _get_conn()
    conn.execute(
        "INSERT INTO users (username, password_hash, role, is_active, created_at) "
        "VALUES (?, ?, ?, 1, ?)",
        (username, generate_password_hash(password), role,
         datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
    )
    conn.commit()
    conn.close()


def update_username(user_id, new_username):
    new_username = (new_username or "").strip()
    if not new_username:
        raise ValueError("Username is required.")
    existing = get_user_by_username(new_username)
    if existing and existing["id"] != user_id:
        raise ValueError(f"Username '{new_username}' is already taken.")
    conn = _get_conn()
    conn.execute("UPDATE users SET username = ? WHERE id = ?", (new_username, user_id))
    conn.commit()
    conn.close()


def update_user_role(user_id, role):
    if role not in ROLES:
        raise ValueError(f"Invalid role '{role}'. Must be one of {ROLES}.")
    conn = _get_conn()
    conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
    conn.commit()
    conn.close()


def set_user_active(user_id, is_active):
    conn = _get_conn()
    conn.execute("UPDATE users SET is_active = ? WHERE id = ?", (1 if is_active else 0, user_id))
    conn.commit()
    conn.close()


def reset_password(user_id, new_password):
    if not new_password or len(new_password) < 6:
        raise ValueError("Password must be at least 6 characters.")
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (generate_password_hash(new_password), user_id),
    )
    conn.commit()
    conn.close()


def delete_user(user_id):
    conn = _get_conn()
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()


def _touch_last_login(user_id):
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET last_login_at = ? WHERE id = ?",
        (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), user_id),
    )
    conn.commit()
    conn.close()


def verify_login(username, password):
    """Returns the user row (dict) on success, or None on any failure."""
    user = get_user_by_username((username or "").strip())
    if not user or not user["is_active"]:
        return None
    if not check_password_hash(user["password_hash"], password or ""):
        return None
    _touch_last_login(user["id"])
    user["last_login_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return user


def find_or_create_google_user(google_id, email, avatar_url=None):
    """
    Resolves a verified Google identity to a local user row, in order:
      1. An account already linked to this google_id -> log in, refresh avatar.
      2. An existing local account with a matching username/email -> link it
         (safe because Google has already verified the email ownership).
      3. Otherwise, create a brand-new account with GOOGLE_DEFAULT_ROLE.

    Returns the user dict, or None if a matched account is deactivated.
    """
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = _get_conn()

    row = conn.execute("SELECT * FROM users WHERE google_id = ?", (google_id,)).fetchone()
    if row:
        user = dict(row)
        if not user["is_active"]:
            conn.close()
            return None
        conn.execute(
            "UPDATE users SET avatar_url = ?, last_login_at = ? WHERE id = ?",
            (avatar_url, now, user["id"]),
        )
        conn.commit()
        conn.close()
        user["avatar_url"] = avatar_url
        user["last_login_at"] = now
        return user

    row = conn.execute("SELECT * FROM users WHERE username = ?", (email,)).fetchone()
    if row:
        user = dict(row)
        if not user["is_active"]:
            conn.close()
            return None
        conn.execute(
            "UPDATE users SET google_id = ?, auth_provider = 'google', avatar_url = ?, "
            "last_login_at = ? WHERE id = ?",
            (google_id, avatar_url, now, user["id"]),
        )
        conn.commit()
        conn.close()
        user.update(google_id=google_id, auth_provider="google", avatar_url=avatar_url, last_login_at=now)
        return user

    # Brand-new account. It still gets a (random, unusable) password hash so
    # the NOT NULL column is satisfied; the user can set a real password
    # later from Account Settings if they also want local sign-in.
    unusable_hash = generate_password_hash(secrets.token_hex(32))
    role = GOOGLE_DEFAULT_ROLE if GOOGLE_DEFAULT_ROLE in ROLES else "viewer"
    cursor = conn.execute(
        "INSERT INTO users (username, password_hash, role, is_active, created_at, "
        "auth_provider, google_id, avatar_url, last_login_at) "
        "VALUES (?, ?, ?, 1, ?, 'google', ?, ?, ?)",
        (email, unusable_hash, role, now, google_id, avatar_url, now),
    )
    conn.commit()
    new_id = cursor.lastrowid
    conn.close()
    return get_user_by_id(new_id)


# ------------------------------------------------------------------
# Current-user lookup + decorators
# ------------------------------------------------------------------

def current_user():
    """Cached per-request lookup of the logged-in user dict, or None."""
    if "user" not in g:
        user_id = session.get("user_id")
        g.user = get_user_by_id(user_id) if user_id else None
        # session points at a user that no longer exists / was deactivated
        if g.user is not None and not g.user["is_active"]:
            g.user = None
    return g.user


def _unauthenticated_response():
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": "Please log in to continue.", "auth_required": True}), 401
    return redirect(url_for("auth.login_page", next=request.path))


def login_required(view):
    """Any logged-in, active user (any role) may access this view."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not current_user():
            return _unauthenticated_response()
        return view(*args, **kwargs)
    return wrapped


def role_required(*roles):
    """
    Require the current user's role to be at least as privileged as the
    lowest role passed in, e.g. role_required("editor") also allows admin.
    """
    minimum = min(ROLE_RANK[r] for r in roles)

    def decorator(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            user = current_user()
            if not user:
                return _unauthenticated_response()
            if ROLE_RANK.get(user["role"], -1) < minimum:
                return jsonify({"ok": False, "error": "You don't have permission to do that."}), 403
            return view(*args, **kwargs)
        return wrapped
    return decorator


def _public_user(user):
    return {
        "id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "auth_provider": user.get("auth_provider") or "local",
        "avatar_url": user.get("avatar_url"),
        "created_at": user.get("created_at"),
        "last_login_at": user.get("last_login_at"),
    }


# ------------------------------------------------------------------
# Routes: login / logout / session
# ------------------------------------------------------------------

@auth_bp.route("/login", methods=["GET"])
def login_page():
    if current_user():
        return redirect(url_for("index"))
    return render_template("login.html", google_enabled=google_oauth_configured())


@auth_bp.route("/api/auth/login", methods=["POST"])
def api_login():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr) or "unknown"
    ip = ip.split(",")[0].strip()  # first hop if behind a proxy chain

    if _login_rate_limited(ip):
        return jsonify({
            "ok": False,
            "error": "Too many login attempts. Please wait a few minutes and try again.",
        }), 429

    payload = request.get_json(force=True, silent=True) or {}
    user = verify_login(payload.get("username"), payload.get("password"))
    if not user:
        _record_login_attempt(ip)
        return jsonify({"ok": False, "error": "Invalid username or password."}), 401

    session.clear()
    session["user_id"] = user["id"]
    session.permanent = True

    return jsonify({"ok": True, "user": _public_user(user)})


@auth_bp.route("/api/auth/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


# ------------------------------------------------------------------
# Routes: Google OAuth ("Continue with Google")
# ------------------------------------------------------------------

@auth_bp.route("/auth/google/login")
def google_login():
    if current_user():
        return redirect(url_for("index"))
    if not google_oauth_configured():
        return redirect(url_for("auth.login_page", error="google_not_configured"))

    state = secrets.token_urlsafe(24)
    session["oauth_state"] = state
    session["oauth_next"] = request.args.get("next") or url_for("index")

    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    }
    return redirect(f"{GOOGLE_AUTH_URL}?{urlencode(params)}")


@auth_bp.route("/auth/google/callback")
def google_callback():
    if request.args.get("error"):
        return redirect(url_for("auth.login_page", error="google_auth_failed"))

    expected_state = session.pop("oauth_state", None)
    next_path = session.pop("oauth_next", None) or url_for("index")
    state = request.args.get("state")
    code = request.args.get("code")

    if not code or not state or state != expected_state:
        return redirect(url_for("auth.login_page", error="google_auth_failed"))

    try:
        token_response = requests.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": GOOGLE_REDIRECT_URI,
            },
            timeout=10,
        )
        token_response.raise_for_status()
        access_token = token_response.json().get("access_token")
        if not access_token:
            raise ValueError("Google did not return an access token.")

        userinfo_response = requests.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        userinfo_response.raise_for_status()
        info = userinfo_response.json()
    except Exception:
        return redirect(url_for("auth.login_page", error="google_auth_failed"))

    if not info.get("email") or not info.get("email_verified", True):
        return redirect(url_for("auth.login_page", error="google_email_unverified"))

    user = find_or_create_google_user(
        google_id=info["sub"],
        email=info["email"],
        avatar_url=info.get("picture"),
    )
    if not user:
        return redirect(url_for("auth.login_page", error="account_deactivated"))

    session.clear()
    session["user_id"] = user["id"]
    session.permanent = True

    return redirect(next_path)


@auth_bp.route("/api/auth/me")
def api_me():
    user = current_user()
    return jsonify({"ok": True, "user": _public_user(user) if user else None})


@auth_bp.route("/api/auth/password", methods=["POST"])
@login_required
def api_change_own_password():
    """Any logged-in user can change their own password."""
    payload = request.get_json(force=True, silent=True) or {}
    user = current_user()

    if not check_password_hash(user["password_hash"], payload.get("current_password") or ""): #type: ignore
        return jsonify({"ok": False, "error": "Current password is incorrect."}), 400

    try:
        reset_password(user["id"], payload.get("new_password")) #type: ignore
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    return jsonify({"ok": True})


@auth_bp.route("/api/auth/profile", methods=["POST"])
@login_required
def api_update_own_profile():
    """
    Any logged-in user can update their own username and/or password from
    the Account Settings modal. Both changes are gated behind the current
    password to guard against a hijacked/left-open session.

    Payload: { current_password, new_username?, new_password? }
    At least one of new_username / new_password must be provided.
    """
    payload = request.get_json(force=True, silent=True) or {}
    user = current_user()

    if not check_password_hash(user["password_hash"], payload.get("current_password") or ""): #type: ignore
        return jsonify({"ok": False, "error": "Current password is incorrect."}), 400

    new_username = (payload.get("new_username") or "").strip()
    new_password = payload.get("new_password") or None

    if not new_username and not new_password:
        return jsonify({"ok": False, "error": "Nothing to update."}), 400

    if new_username and new_username != user["username"]: #type: ignore
        try:
            update_username(user["id"], new_username) #type: ignore
        except ValueError as e:
            return jsonify({"ok": False, "error": str(e)}), 400

    if new_password:
        try:
            reset_password(user["id"], new_password) #type: ignore
        except ValueError as e:
            return jsonify({"ok": False, "error": str(e)}), 400

    updated_user = get_user_by_id(user["id"]) #type: ignore
    return jsonify({"ok": True, "user": _public_user(updated_user)})


# ------------------------------------------------------------------
# Routes: admin user management (admin role only)
# ------------------------------------------------------------------

@auth_bp.route("/api/users", methods=["GET"])
@role_required("admin")
def api_list_users():
    search = request.args.get("search") or None
    role = request.args.get("role") or None
    status = request.args.get("status") or None
    return jsonify({"ok": True, "users": list_users(search=search, role=role, status=status)})


@auth_bp.route("/api/users/stats", methods=["GET"])
@role_required("admin")
def api_user_stats():
    return jsonify({"ok": True, "stats": get_user_stats()})


@auth_bp.route("/api/users", methods=["POST"])
@role_required("admin")
def api_create_user():
    payload = request.get_json(force=True, silent=True) or {}
    try:
        create_user(payload.get("username"), payload.get("password"), payload.get("role", "viewer"))
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    return jsonify({"ok": True, "users": list_users()}), 201


@auth_bp.route("/api/users/<int:user_id>/role", methods=["POST"])
@role_required("admin")
def api_update_user_role(user_id):
    payload = request.get_json(force=True, silent=True) or {}
    if current_user()["id"] == user_id: #type: ignore
        return jsonify({"ok": False, "error": "You can't change your own role."}), 400
    try:
        update_user_role(user_id, payload.get("role", ""))
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    return jsonify({"ok": True, "users": list_users()})


@auth_bp.route("/api/users/<int:user_id>/active", methods=["POST"])
@role_required("admin")
def api_set_user_active(user_id):
    payload = request.get_json(force=True, silent=True) or {}
    if current_user()["id"] == user_id and not payload.get("is_active", True): #type: ignore
        return jsonify({"ok": False, "error": "You can't deactivate your own account."}), 400
    set_user_active(user_id, bool(payload.get("is_active", True)))
    return jsonify({"ok": True, "users": list_users()})


@auth_bp.route("/api/users/<int:user_id>/password", methods=["POST"])
@role_required("admin")
def api_admin_reset_password(user_id):
    payload = request.get_json(force=True, silent=True) or {}
    try:
        reset_password(user_id, payload.get("password"))
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    return jsonify({"ok": True})


@auth_bp.route("/api/users/<int:user_id>", methods=["DELETE"])
@role_required("admin")
def api_delete_user(user_id):
    if current_user()["id"] == user_id: #type: ignore
        return jsonify({"ok": False, "error": "You can't delete your own account while logged in."}), 400
    delete_user(user_id)
    return jsonify({"ok": True, "users": list_users()})