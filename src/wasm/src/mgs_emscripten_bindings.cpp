#include <emscripten/bind.h>
#include <vector>
#include <memory>
#include <iostream>

#include "mgs_gaussian.hpp"
#include "mgs_ply.hpp"

//-------------------------------------------//

static mat4 parse_mat4(const emscripten::val& val);

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
    	.property("dynamic", &mgs::GaussiansPacked::dynamic)
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

		.property("velocities", emscripten::optional_override([](const mgs::GaussiansPacked& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.velocities.size() * sizeof(vec4), 
				(const uint8_t*)self.velocities.data()
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

	emscripten::class_<mgs::GaussianSorter>("GaussianSorter")
		.smart_ptr<std::shared_ptr<mgs::GaussianSorter>>("GaussianSorter")

		.constructor(emscripten::optional_override([](const std::shared_ptr<mgs::GaussiansPacked>& gaussians)
		{
			return std::make_shared<mgs::GaussianSorter>(gaussians);
		}))

		.function("sort", emscripten::optional_override([](mgs::GaussianSorter& self, const emscripten::val& viewVal, const emscripten::val& projVal, float time)
		{
			mat4 view = parse_mat4(viewVal);
			mat4 proj = parse_mat4(projVal);

			self.sort(view, proj, time);
		}))
		
		.function("sortAsyncStart", emscripten::optional_override([](mgs::GaussianSorter& self, const emscripten::val& viewVal, const emscripten::val& projVal, float time)
		{
			mat4 view = parse_mat4(viewVal);
			mat4 proj = parse_mat4(projVal);

			self.sort_async_start(view, proj, time);
		}))

		.property("sortPending", &mgs::GaussianSorter::sort_async_pending)
		
		.function("sortAsyncTryJoin", &mgs::GaussianSorter::sort_async_tryjoin)

		.property("latest", emscripten::optional_override([](const mgs::GaussianSorter& self)
		{
			return emscripten::val(emscripten::typed_memory_view(
				self.get_latest().size(), self.get_latest().data()
			));
		}));

	emscripten::function("loadPly", emscripten::optional_override([](const emscripten::val& arg)
	{
		emscripten::val bufView = emscripten::val::global("Uint8Array").new_(arg);
		std::vector<uint8_t> data = emscripten::convertJSArrayToNumberVector<std::uint8_t>(bufView);

		return std::make_shared<mgs::GaussiansPacked>(mgs::ply::load(data));
	}));
}

//-------------------------------------------//

static mat4 parse_mat4(const emscripten::val& val)
{
	std::vector<float> arr = emscripten::convertJSArrayToNumberVector<float>(val);
	if(arr.size() != 16)
		throw std::runtime_error("4x4 matrices must have 16 elements!");

	mat4 mat;
	std::memcpy(&mat, arr.data(), 16 * sizeof(float));

	return mat;
}