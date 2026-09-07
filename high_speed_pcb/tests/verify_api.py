import sys,json,importlib.util,pathlib,math
spec=importlib.util.spec_from_file_location('server',pathlib.Path(__file__).resolve().parents[1]/'server.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
for zl in [0,25,50,100,math.inf]:
 value=m.reflection(50,zl);json.dumps(value,allow_nan=False)
 assert -1<=value['gamma']<=1
assert m.reflection(50,50)['return_loss_infinite']
assert m.reflection(50,0)['vswr_infinite']
for z0,zl in [(0,50),(50,-1),(math.nan,50),(50,math.nan)]:
 try:m.reflection(z0,zl)
 except ValueError:pass
 else:raise AssertionError('domain validation')
print(json.dumps([m.microstrip_model(*row) for row in json.loads(sys.argv[1])],allow_nan=False))
