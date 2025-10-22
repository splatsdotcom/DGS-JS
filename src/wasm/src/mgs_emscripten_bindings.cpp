#include <emscripten/bind.h>
#include <vector>
#include <memory>
#include <iostream>

#include "mgs_gaussian.hpp"
#include "mgs_ply.hpp"

//-------------------------------------------//

EMSCRIPTEN_BINDINGS(libmgs_js)
{
	emscripten::class_<mgs::GaussiansPacked>("Gaussians")
		.smart_ptr<std::shared_ptr<mgs::GaussiansPacked>>("Gaussians")

		.constructor(emscripten::optional_override([]()
		{
			return std::make_shared<mgs::GaussiansPacked>(mgs::Gaussians());
		}))

		.constructor(emscripten::optional_override([](const emscripten::val& arg)
		{
			emscripten::val bufView = emscripten::val::global("Uint8Array").new_(arg);
			std::vector<uint8_t> data = emscripten::convertJSArrayToNumberVector<uint8_t>(bufView);

			return std::make_shared<mgs::GaussiansPacked>(data);
		}))

    	.property("length", &mgs::GaussiansPacked::count)
    	.property("shDegree", &mgs::GaussiansPacked::shDegree)
    	.property("colorMin", &mgs::GaussiansPacked::colorMin)
    	.property("colorMax", &mgs::GaussiansPacked::colorMax)
    	.property("shMin", &mgs::GaussiansPacked::shMin)
    	.property("shMax", &mgs::GaussiansPacked::shMax)

		.property("means", emscripten::optional_override([](const mgs::GaussiansPacked& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.means.size() * sizeof(vec4), 
				(const uint8_t*)self.means.data()
			));
		}))

		.property("covariances", emscripten::optional_override([](const mgs::GaussiansPacked& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.covariances.size() * sizeof(float), 
				(const uint8_t*)self.covariances.data()
			));
		}))

		.property("opacities", emscripten::optional_override([](const mgs::GaussiansPacked& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.opacities.size() * sizeof(uint8_t), 
				(const uint8_t*)self.opacities.data()
			));
		}))

		.property("colors", emscripten::optional_override([](const mgs::GaussiansPacked& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.colors.size() * sizeof(uint16_t), 
				(const uint8_t*)self.colors.data()
			));
		}))

		.property("shs", emscripten::optional_override([](const mgs::GaussiansPacked& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.shs.size() * sizeof(uint8_t), 
				(const uint8_t*)self.shs.data()
			));
		}))

		.function("serialize", emscripten::optional_override([](const mgs::GaussiansPacked& self) 
		{
			std::vector<uint8_t> data = self.serialize();
			emscripten::val u8array = emscripten::val::global("Uint8Array").new_(data.size());
			emscripten::val memoryView = emscripten::val(emscripten::typed_memory_view(
				data.size(), data.data()
			));

			u8array.call<void>("set", memoryView);
			return u8array;
		}));

	emscripten::function("loadPly", emscripten::optional_override([](const emscripten::val& arg)
	{
		emscripten::val bufView = emscripten::val::global("Uint8Array").new_(arg);
		std::vector<uint8_t> data = emscripten::convertJSArrayToNumberVector<std::uint8_t>(bufView);

		return std::make_shared<mgs::GaussiansPacked>(mgs::ply::load(data));
	}));
}
