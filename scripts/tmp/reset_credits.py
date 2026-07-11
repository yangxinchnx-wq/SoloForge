import sqlite3

db = r"c:\Users\yangx\Desktop\SoloForge\python\data\ai_society\ai_society.db"
c = sqlite3.connect(db)
c.execute("UPDATE economy SET credits=1000.0 WHERE agent_id='code_agent'")
c.commit()
r = c.execute("SELECT agent_id, credits FROM economy WHERE agent_id='code_agent'").fetchone()
if r:
    print(f"{r[0]}: {r[1]}")
else:
    print("code_agent not found in economy table")
c.close()
