package expo.modules.t3markdowntext

import android.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class T3ContextChipColorTest {
  @Test
  fun readsReactNativeAlphaLastHex() {
    assertEquals(Color.argb(0x80, 0x20, 0x22, 0x24), T3ContextChip.color("#20222480", Color.BLACK))
  }

  @Test
  fun keepsOpaqueHex() {
    assertEquals(Color.rgb(0x1b, 0x4e, 0xd8), T3ContextChip.color("#1b4ed8", Color.BLACK))
  }

  @Test
  fun fallsBackForUnparseableColors() {
    assertEquals(Color.BLACK, T3ContextChip.color("rgba(0, 0, 0, 0.5)", Color.BLACK))
  }
}
