import json


CONSOLE_EXPR_MAX_CHARS = 900


def build_memwrite_expression(path_parts, value):
    path_json = json.dumps(".".join(path_parts), ensure_ascii=True)
    value_json = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    return f"memwrite({path_json}, {value_json})"


def build_mempatch_expression(path_parts, patch):
    path_json = json.dumps(".".join(path_parts), ensure_ascii=True)
    patch_json = json.dumps(patch, ensure_ascii=True, separators=(",", ":"))
    return f"mempatch({path_json}, {patch_json})"


def build_memdelete_expression(path_parts):
    path_json = json.dumps(".".join(path_parts), ensure_ascii=True)
    return f"memdelete({path_json})"


def is_expression_too_long(expression, max_chars=CONSOLE_EXPR_MAX_CHARS):
    return len(expression) > int(max_chars)


def collect_changed_leaf_writes(base_path_parts, existing_value, desired_patch):
    writes = []
    _collect(base_path_parts, existing_value, desired_patch, writes)
    return writes


def _collect(path_parts, existing_value, desired_value, writes):
    if isinstance(desired_value, dict):
        existing_obj = existing_value if isinstance(existing_value, dict) else {}
        for key, child in desired_value.items():
            _collect(path_parts + [str(key)], existing_obj.get(key), child, writes)
        return
    if existing_value != desired_value:
        writes.append((path_parts, desired_value))
