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
import sqlite3
from datetime import datetime
from functools import wraps

from flask import Blueprint, request, jsonify, session, render_template, redirect, url_for, g
from werkzeug.security import generate_password_hash, check_password_hash

DB_PATH = os.environ.get("USERS_DB_PATH", "users.db")
ROLES = ("viewer", "editor", "admin")
ROLE_RANK = {"viewer": 0, "editor": 1, "admin": 2}

auth_bp = Blueprint("auth", __name__)


# ------------------------------------------------------------------
# DB setup
# ------------------------------------------------------------------

def _get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


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


def list_users():
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, username, role, is_active, created_at FROM users ORDER BY id"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


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


def verify_login(username, password):
    """Returns the user row (dict) on success, or None on any failure."""
    user = get_user_by_username((username or "").strip())
    if not user or not user["is_active"]:
        return None
    if not check_password_hash(user["password_hash"], password or ""):
        return None
    return user


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
    return {"id": user["id"], "username": user["username"], "role": user["role"]}


# ------------------------------------------------------------------
# Routes: login / logout / session
# ------------------------------------------------------------------

@auth_bp.route("/login", methods=["GET"])
def login_page():
    if current_user():
        return redirect(url_for("index"))
    return render_template("login.html")


@auth_bp.route("/api/auth/login", methods=["POST"])
def api_login():
    payload = request.get_json(force=True, silent=True) or {}
    user = verify_login(payload.get("username"), payload.get("password"))
    if not user:
        return jsonify({"ok": False, "error": "Invalid username or password."}), 401

    session.clear()
    session["user_id"] = user["id"]
    session.permanent = True

    return jsonify({"ok": True, "user": _public_user(user)})


@auth_bp.route("/api/auth/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


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
    return jsonify({"ok": True, "users": list_users()})


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