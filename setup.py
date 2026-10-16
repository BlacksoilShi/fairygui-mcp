"""Create a new private runtime config; never replace an existing config/project."""
import argparse
import json
from pathlib import Path
import secrets
import sys

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--project', type=Path, required=True, help='Existing project directory containing one .fairy')
    p.add_argument('--editor', type=Path, required=True, help='Existing original FairyGUI editor executable')
    p.add_argument('--runtime', type=Path, required=True, help='Separate directory for private config, logs and state')
    p.add_argument('--port', type=int, default=17931)
    a = p.parse_args()
    project, editor, runtime = a.project.resolve(), a.editor.resolve(), a.runtime.resolve()
    if not 1024 <= a.port <= 65535 or len(list(project.glob('*.fairy'))) != 1 or not editor.is_file():
        p.error('Check port, executable, and the single .fairy project file')
    if runtime == project or runtime.is_relative_to(project):
        p.error('Runtime must be separate from project source')
    runtime.mkdir(parents=True, exist_ok=True)
    config = runtime/'config.json'
    value = dict(projectPath=str(project), editorPath=str(editor), python=sys.executable,
                 host='127.0.0.1', port=a.port, token=secrets.token_hex(32),
                 publishDir=str(project.parent/(project.name+'-published')),
                 screenshotDir=str(project.parent/(project.name+'-screenshots')))
    with config.open('x', encoding='utf8') as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write('\n')
    print(json.dumps({'config':str(config), 'tokenPrinted':False, 'projectModified':False}))

if __name__ == '__main__':
    main()
