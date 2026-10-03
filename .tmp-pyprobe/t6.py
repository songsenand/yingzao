from openscad import *
base = cube([20,20,5])
bump = translate(cube([5,5,5]), [7,7,5])
results = {}
for name, expr in [("a|b", base | bump), ("a+b", base + bump), ("a&b", base & bump)]:
    try:
        show(expr); results[name] = "OK"
    except Exception as e:
        results[name] = f"fail: {e}"
print(results)
