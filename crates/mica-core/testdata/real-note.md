---
title: Portable parser fixture
tags:
    - mica
    - regression
---

# Mixed markdown

Ordinary prose with **formatting**, a [link](https://example.invalid), emoji 😀,
and a final line that deliberately mixes punctuation: `{[(...)]}`.

> [!note] Callout title
> Quoted body with an apparent directive:
> :::tab not-structural-here

````mica-example
```mica id=inside-a-foreign-fence
not a real outer block
```
````

::::tabs
:::tab First {icon=rocket}
Body one.
:::
:::tab Second
:::grid {cols=2 gap=8}
:::cell
Alpha
:::
:::cell

```rust
fn main() { println!(":::"); }
```

:::
:::
:::
::::

Final paragraph without special handling.
