import sys
sys.stdout.reconfigure(encoding='utf-8')
with open(r'C:\Users\yangx\Desktop\SoloForge\infra\schema.surql', 'r', encoding='utf-8') as f:
    content = f.read()
    print(content[:1000])
