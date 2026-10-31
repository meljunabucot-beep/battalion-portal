from app.database import Base, engine, SessionLocal
from app.models import User, seed_offices
from app.auth import hash_password


def seed():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # Seed the default office list (idempotent)
        seed_offices(db)

        # Commanding Officer
        if not db.query(User).filter(User.username == "Warrior6").first():
            db.add(User(
                username="Warrior6",
                password_hash=hash_password("Semperp@r@tus"),
                role="co",
                status="active",
                offices=[],
            ))

        # Admin 1
        if not db.query(User).filter(User.username == "Admin1").first():
            db.add(User(
                username="Admin1",
                password_hash=hash_password("Semper&Paratus1"),
                role="admin",
                status="active",
                offices=[],
            ))

        # Admin 2
        if not db.query(User).filter(User.username == "Admin2").first():
            db.add(User(
                username="Admin2",
                password_hash=hash_password("Semper&Paratus1"),
                role="admin",
                status="active",
                offices=[],
            ))

        db.commit()
        print("Seeded.")
    finally:
        db.close()


if __name__ == "__main__":
    seed()