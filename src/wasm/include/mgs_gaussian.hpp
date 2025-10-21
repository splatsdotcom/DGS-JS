/* mgs_gaussian.hpp
 *
 * contains the definition for the basic gaussian type
 */

#ifndef MGS_GAUSSIAN_HPP
#define MGS_GAUSSIAN_HPP

#include <array>
#include <vector>
#include <thread>
#include <atomic>
#include <vector>
#include <memory>
#include <mutex>
#include <optional>

#include "quickmath.hpp"
using namespace qm;

#define MGS_MAX_SH_DEGREE 3U
#define MGS_MAX_SH_COEFFS (3 * (MGS_MAX_SH_DEGREE + 1) * (MGS_MAX_SH_DEGREE + 1))
#define MGS_MAX_SH_COEFFS_REST (MGS_MAX_SH_COEFFS - 3) //not including dc coeffs

namespace mgs
{

//-------------------------------------------//

class Gaussian;
class GaussianPacked;

/**
 * all parameters describing a 3D gaussian with spherical harmonics, uncompressed
 */
class Gaussian
{
public:
	Gaussian(const vec3& pos, const vec3& scale, const quaternion& orient, const vec4& color, const std::array<vec3, MGS_MAX_SH_COEFFS_REST>& sh);

	GaussianPacked pack() const;

	vec3 pos;
	vec3 scale;
	quaternion orient;

	vec4 color;
	std::array<vec3, MGS_MAX_SH_COEFFS_REST> sh;
};

/**
 * all parameters describing a 3D gaussian with spherical harmonics, compressed for rendering
 */
class alignas(16) GaussianPacked
{
public:
	Gaussian unpack() const;

	float covariance1[3];
	uint32_t colorRG; 
	float covariance2[3];
	uint32_t colorBA;
	vec3 pos;
	std::array<uint32_t, (MGS_MAX_SH_COEFFS_REST + 1) / 2> sh; //2-bytes each, packed into uints
};

/**
 * a group of gaussians
 */
class GaussianGroup
{
public:
	GaussianGroup() = default;
	GaussianGroup(const std::vector<GaussianPacked>& gaussians, uint32_t shDegree = 0);
	GaussianGroup(const std::vector<Gaussian>& gaussians, uint32_t shDegree = 0);

	uint32_t get_num_gaussians() const;
	const std::vector<GaussianPacked>& get_gaussians() const;

	uint32_t get_sh_degree() const;

	std::vector<uint8_t> serialize() const;
	void deserialize(const std::vector<uint8_t>& serialized);

private:
	std::vector<GaussianPacked> m_gaussians;
	uint32_t m_shDegree;
};

}; //namespace mgs

#endif //#ifndef MGS_GAUSSIAN_HPP
